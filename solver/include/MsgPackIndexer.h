#pragma once

#include "json.hpp"
#include <SQLiteCpp/SQLiteCpp.h>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <msgpack.hpp>
#include <stdexcept>
#include <string>
#include <vector>
#include <zstd.h>

using nlohmann::json;

template <class Packer> static void packJsonScalar(Packer &pk, const json &j) {
  switch (j.type()) {
  case json::value_t::null:
    pk.pack_nil();
    break;
  case json::value_t::boolean:
    pk.pack(j.get<bool>());
    break;
  case json::value_t::number_integer:
    pk.pack(j.get<long long>());
    break;
  case json::value_t::number_unsigned:
    pk.pack(j.get<unsigned long long>());
    break;
  case json::value_t::number_float:
    pk.pack(j.get<double>());
    break;
  case json::value_t::string: {
    auto const &s = j.get_ref<const std::string &>();
    pk.pack_str(s.size());
    pk.pack_str_body(s.data(), s.size());
  } break;
  default:
    throw std::runtime_error("packJsonScalar: unsupported type");
  }
}

template <typename Packer>
static void packJsonInline(Packer &pk, const json &j) {
  switch (j.type()) {
  case json::value_t::object:
    pk.pack_map(j.size());
    for (auto it = j.cbegin(); it != j.cend(); ++it) {
      pk.pack(it.key());
      packJsonInline(pk, it.value()); // Recurse inline
    }
    break;
  case json::value_t::array:
    pk.pack_array(j.size());
    for (const auto &element : j) {
      packJsonInline(pk, element); // Recurse inline
    }
    break;
  default:
    packJsonScalar(pk, j); // Use existing scalar packer
    break;
  }
}

static inline bool shouldIndex(const std::string &path) noexcept {
  if (path.empty())
    return true;

  size_t lastDot = path.find_last_of('.');
  std::string key =
      (lastDot == std::string::npos) ? path : path.substr(lastDot + 1);

  if (key == "c" || key == "d" || key == "s")
    return true;

  std::string parent_path =
      (lastDot == std::string::npos) ? "" : path.substr(0, lastDot);

  std::string parent_key;
  if (!parent_path.empty()) {
    size_t prevDot = parent_path.find_last_of('.');
    parent_key = (prevDot == std::string::npos)
                     ? parent_path
                     : parent_path.substr(prevDot + 1);
  }

  if (parent_key == "c" && !key.empty() &&
      std::all_of(key.begin(), key.end(), [](char ch) {
        return std::isdigit(static_cast<unsigned char>(ch));
      })) {
    return true;
  }

  if (parent_key == "d")
    return true;

  const std::string ss_suffix = ".s.s";
  if (!parent_path.empty()) {
    if (parent_path == "s.s" ||
        (parent_path.size() >
             ss_suffix.size() && // Handles deeper parents like "c.0.s.s"
         parent_path.rfind(ss_suffix) ==
             parent_path.size() - ss_suffix.size())) {
      return true;
    }
  }

  return false;
}

static void storeJsonInDbInterned(SQLite::Statement &insertPathStmt,
                                  SQLite::Statement &selectPathIdStmt,
                                  SQLite::Statement &insertNodeStmt,
                                  const json &j, const std::string &path_text,
                                  bool compress_data) {
  if (!shouldIndex(path_text)) {
    if (j.is_object()) {
      for (auto it = j.cbegin(); it != j.cend(); ++it) {
        std::string child_path =
            path_text.empty() ? it.key() : path_text + "." + it.key();
        storeJsonInDbInterned(insertPathStmt, selectPathIdStmt, insertNodeStmt,
                              it.value(), child_path, compress_data);
      }
    } else if (j.is_array()) {
      for (std::size_t i = 0; i < j.size(); ++i) {
        std::string child_path = path_text.empty()
                                     ? std::to_string(i)
                                     : path_text + "." + std::to_string(i);
        storeJsonInDbInterned(insertPathStmt, selectPathIdStmt, insertNodeStmt,
                              j[i], child_path, compress_data);
      }
    }
    return;
  }

  long long path_id = -1;
  try {
    insertPathStmt.bind(1, path_text);
    insertPathStmt.exec();
    insertPathStmt.reset();

    selectPathIdStmt.bind(1, path_text);
    if (selectPathIdStmt.executeStep()) {
      path_id = selectPathIdStmt.getColumn(0).getInt64();
    } else {
      throw std::runtime_error(
          "Failed to retrieve path_id after INSERT OR IGNORE for path: " +
          path_text);
    }
    selectPathIdStmt.reset();
  } catch (const SQLite::Exception &e) {
    insertPathStmt.reset();
    selectPathIdStmt.reset();
    throw std::runtime_error("SQLite path handling failed for path '" +
                             path_text + "': " + e.what());
  }

  msgpack::sbuffer sbuf;
  msgpack::packer<msgpack::sbuffer> pk(sbuf);
  std::vector<std::pair<std::string, const json *>> deferred_children;

  switch (j.type()) {
  case json::value_t::object:
    pk.pack_map(j.size());
    for (auto it = j.cbegin(); it != j.cend(); ++it) {
      pk.pack(it.key());
      std::string child_path =
          path_text.empty() ? it.key() : path_text + "." + it.key();
      if (shouldIndex(child_path)) {
        pk.pack_nil();
        deferred_children.push_back({child_path, &it.value()});
      } else {
        packJsonInline(pk, it.value());
      }
    }
    break;
  case json::value_t::array:
    pk.pack_array(j.size());
    for (std::size_t i = 0; i < j.size(); ++i) {
      std::string child_path = path_text.empty()
                                   ? std::to_string(i)
                                   : path_text + "." + std::to_string(i);
      if (shouldIndex(child_path)) {
        pk.pack_nil();
        deferred_children.push_back({child_path, &j[i]});
      } else {
        packJsonInline(pk, j[i]);
      }
    }
    break;
  default:
    packJsonInline(pk, j);
    break;
  }

  std::vector<char> compressed_sbuf;
  const char *data_to_bind = nullptr;
  size_t size_to_bind = 0;

  if (compress_data && sbuf.size() > 0) {
    const size_t cBuffSize = ZSTD_compressBound(sbuf.size());
    compressed_sbuf.resize(cBuffSize);

    size_t cSize = ZSTD_compress(compressed_sbuf.data(), cBuffSize, sbuf.data(),
                                 sbuf.size(), 3);

    if (ZSTD_isError(cSize)) {
      throw std::runtime_error(
          "Failed to compress msgpack data with ZSTD for path '" + path_text +
          "': " + ZSTD_getErrorName(cSize));
    }
    compressed_sbuf.resize(cSize);

    data_to_bind = compressed_sbuf.data();
    size_to_bind = cSize;
  } else {

    data_to_bind = sbuf.data();
    size_to_bind = sbuf.size();
  }

  try {
    insertNodeStmt.bind(1, static_cast<int64_t>(path_id));
    insertNodeStmt.bind(2, size_to_bind == 0 ? nullptr : data_to_bind,
                        size_to_bind);
    insertNodeStmt.exec();
    insertNodeStmt.reset();
  } catch (const SQLite::Exception &e) {
    insertNodeStmt.reset();
    throw std::runtime_error("SQLite node insert failed for path_id " +
                             std::to_string(path_id) + " (path '" + path_text +
                             "'): " + e.what());
  }

  for (const auto &deferred : deferred_children) {
    storeJsonInDbInterned(insertPathStmt, selectPathIdStmt, insertNodeStmt,
                          *deferred.second, deferred.first, compress_data);
  }
}

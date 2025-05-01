#include "DictRanker.h"
#include "CardsUtils.h"
#include "library.h"

#include <algorithm>
#include <fmt/format.h>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

DictRanker::DictRanker(const std::string &dic_dir, int lines)
    : HandRanker(dic_dir, lines) {
  std::ifstream infile(this->dic_dir);
  if (!infile.is_open()) {
    throw std::runtime_error(
        fmt::format("Failed to open dictionary file: {}", this->dic_dir));
  }
  if (this->lines > 0) {
    cardslong2rank.reserve(this->lines);
  }

  std::string line;
  while (std::getline(infile, line)) {
    std::vector<std::string> linesp = string_split(line, ',');
    if (linesp.size() != 2)
      throw std::runtime_error(fmt::format(
          "Dictionary line format error (expected 2 parts): {}", line));

    const std::string &cards_str = linesp[0];
    int rank = std::stoi(linesp[1]);
    std::vector<std::string> cards = string_split(cards_str, '-');
    if (cards.size() != 5)
      throw std::runtime_error(fmt::format(
          "Dictionary card format error (expected 5 cards): {} length {}",
          cards_str, cards.size()));

    uint64_t key = Card::boardCards2long(cards);
    auto [it, success] = this->cardslong2rank.emplace(key, rank);
    if (!success) {
      throw std::runtime_error(
          fmt::format("Dictionary key repeated: {}", cards_str));
    }
  }
}

HandRanker::Rank DictRanker::compair(const std::vector<Card> &private_former,
                                     const std::vector<Card> &private_latter,
                                     const std::vector<Card> &public_board) {
  constexpr size_t PRIVATE_HAND_SIZE = 2;
  constexpr size_t PUBLIC_BOARD_SIZE = 5;
  constexpr size_t TOTAL_CARDS = PRIVATE_HAND_SIZE + PUBLIC_BOARD_SIZE;

  if (private_former.size() != PRIVATE_HAND_SIZE)
    throw std::runtime_error(
        fmt::format("private former size incorrect, expected {}, actually {}",
                    PRIVATE_HAND_SIZE, private_former.size()));
  if (private_latter.size() != PRIVATE_HAND_SIZE)
    throw std::runtime_error(
        fmt::format("private latter size incorrect, expected {}, actually {}",
                    PRIVATE_HAND_SIZE, private_latter.size()));
  if (public_board.size() != PUBLIC_BOARD_SIZE)
    throw std::runtime_error(
        fmt::format("public board size incorrect, expected {}, actually {}",
                    PUBLIC_BOARD_SIZE, public_board.size()));

  std::vector<Card> former_cards;
  former_cards.reserve(TOTAL_CARDS);
  former_cards.insert(former_cards.end(), private_former.begin(),
                      private_former.end());
  former_cards.insert(former_cards.end(), public_board.begin(),
                      public_board.end());
  int rank_former = this->getRank(former_cards);

  std::vector<Card> latter_cards;
  latter_cards.reserve(TOTAL_CARDS);
  latter_cards.insert(latter_cards.end(), private_latter.begin(),
                      private_latter.end());
  latter_cards.insert(latter_cards.end(), public_board.begin(),
                      public_board.end());
  int rank_latter = this->getRank(latter_cards);

  return this->compairRanks(rank_former, rank_latter);
}

HandRanker::Rank DictRanker::compair(const std::vector<int> &private_former,
                                     const std::vector<int> &private_latter,
                                     const std::vector<int> &public_board) {
  constexpr size_t PRIVATE_HAND_SIZE = 2;
  constexpr size_t PUBLIC_BOARD_SIZE = 5;
  constexpr size_t TOTAL_CARDS = PRIVATE_HAND_SIZE + PUBLIC_BOARD_SIZE;

  if (private_former.size() != PRIVATE_HAND_SIZE)
    throw std::runtime_error(
        fmt::format("private former size incorrect, expected {}, actually {}",
                    PRIVATE_HAND_SIZE, private_former.size()));
  if (private_latter.size() != PRIVATE_HAND_SIZE)
    throw std::runtime_error(
        fmt::format("private latter size incorrect, expected {}, actually {}",
                    PRIVATE_HAND_SIZE, private_latter.size()));
  if (public_board.size() != PUBLIC_BOARD_SIZE)
    throw std::runtime_error(
        fmt::format("public board size incorrect, expected {}, actually {}",
                    PUBLIC_BOARD_SIZE, public_board.size()));

  std::vector<int> former_cards;
  former_cards.reserve(TOTAL_CARDS);
  former_cards.insert(former_cards.end(), private_former.begin(),
                      private_former.end());
  former_cards.insert(former_cards.end(), public_board.begin(),
                      public_board.end());
  int rank_former = this->getRank(former_cards);

  std::vector<int> latter_cards;
  latter_cards.reserve(TOTAL_CARDS);
  latter_cards.insert(latter_cards.end(), private_latter.begin(),
                      private_latter.end());
  latter_cards.insert(latter_cards.end(), public_board.begin(),
                      public_board.end());
  int rank_latter = this->getRank(latter_cards);

  return this->compairRanks(rank_former, rank_latter);
}

int DictRanker::getRank(const std::vector<Card> &cards) const {
  std::vector<int> cards_int;
  cards_int.reserve(cards.size());
  for (const auto &card : cards) {
    cards_int.push_back(card.getCardInt());
  }
  return this->getRank(cards_int);
}

int DictRanker::getRank(const std::vector<int> &cards) const {
  Combinations<int> comb_cards(cards, 5);

  int min_rank = std::numeric_limits<int>::max();

  for (const std::vector<int> &one_comb : comb_cards) {
    constexpr size_t COMBINATION_SIZE = 5;
    if (one_comb.size() != COMBINATION_SIZE)
      throw std::runtime_error(
          fmt::format("Internal error: card combination size incorrect: {} "
                      "should be {}",
                      one_comb.size(), COMBINATION_SIZE));

    uint64_t comb_uint64 = Card::boardInts2long(one_comb);

    auto it = this->cardslong2rank.find(comb_uint64);
    if (it == this->cardslong2rank.end()) {
      std::string board_str;
      for (size_t i = 0; i < one_comb.size(); ++i) {
        board_str +=
            std::to_string(one_comb[i]) + (i == one_comb.size() - 1 ? "" : ",");
      }
      throw std::runtime_error(fmt::format(
          "Rank not found in dictionary for combination key: {} (board: [{}])",
          comb_uint64, board_str));
    }
    int rank = it->second;

    min_rank = std::min(rank, min_rank);
  }

  if (min_rank == std::numeric_limits<int>::max()) {
    throw std::runtime_error(
        fmt::format("Could not determine minimum rank for input cards (size: "
                    "{}). No valid 5-card combinations found or processed.",
                    cards.size()));
  }

  return min_rank;
}

int DictRanker::get_rank(const std::vector<Card> &private_hand,
                         const std::vector<Card> &public_board) const {
  std::vector<Card> concatenate_vec;
  concatenate_vec.reserve(private_hand.size() + public_board.size());
  concatenate_vec.insert(concatenate_vec.end(), private_hand.begin(),
                         private_hand.end());
  concatenate_vec.insert(concatenate_vec.end(), public_board.begin(),
                         public_board.end());
  return this->getRank(concatenate_vec);
}

int DictRanker::get_rank(const std::vector<int> &private_hand,
                         const std::vector<int> &public_board) const {
  std::vector<int> concatenate_vec;
  concatenate_vec.reserve(private_hand.size() + public_board.size());
  concatenate_vec.insert(concatenate_vec.end(), private_hand.begin(),
                         private_hand.end());
  concatenate_vec.insert(concatenate_vec.end(), public_board.begin(),
                         public_board.end());
  return this->getRank(concatenate_vec);
}

int DictRanker::get_rank(uint64_t private_hand, uint64_t public_board) const {
  return this->get_rank(Card::long2board(private_hand),
                        Card::long2board(public_board));
}
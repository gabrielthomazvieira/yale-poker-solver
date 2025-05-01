#include "PokerSolver.h"
#include "MsgPackIndexer.h"

class FastSBuf : public msgpack::sbuffer {
public:
  using msgpack::sbuffer::sbuffer;
  std::streampos tellp() const noexcept { return std::streampos(size()); }
};

PokerSolver::PokerSolver() {}

PokerSolver::PokerSolver(string ranks, string suits, string compairer_file,
                         int compairer_file_lines) {
  vector<string> ranks_vector = string_split(ranks, ',');
  vector<string> suits_vector = string_split(suits, ',');
  this->deck = Deck(ranks_vector, suits_vector);
  this->compairer =
      make_shared<DictRanker>(compairer_file, compairer_file_lines);
}

void PokerSolver::load_game_tree(string game_tree_file) {
  shared_ptr<GameTree> game_tree =
      make_shared<GameTree>(game_tree_file, this->deck);
  this->game_tree = game_tree;
}

void PokerSolver::build_game_tree(float oop_commit, float ip_commit,
                                  int current_round, int raise_limit,
                                  float small_blind, float big_blind,
                                  float stack,
                                  GameTreeBuildingSettings buildingSettings,
                                  float allin_threshold) {

  shared_ptr<GameTree> game_tree = make_shared<GameTree>(
      this->deck, oop_commit, ip_commit, current_round, raise_limit,
      small_blind, big_blind, stack, buildingSettings, allin_threshold);
  this->game_tree = game_tree;
}

void PokerSolver::train(string p1_range, string p2_range, string boards,
                        string log_file, int iteration_number,
                        int print_interval, string algorithm, int warmup,
                        float accuracy, bool use_isomorphism, int threads) {
  string player1RangeStr = p1_range;
  string player2RangeStr = p2_range;

  vector<string> board_str_arr = string_split(boards, ',');
  vector<int> initialBoard;
  for (string one_board_str : board_str_arr) {
    initialBoard.push_back(Card::strCard2int(one_board_str));
  }

  vector<PrivateCards> player1Range =
      PrivateRangeConverter::rangeStr2Cards(player1RangeStr, initialBoard);
  vector<PrivateCards> player2Range =
      PrivateRangeConverter::rangeStr2Cards(player2RangeStr, initialBoard);
  string logfile_name = log_file;
  this->solver = make_shared<DCfrSolver>(
      game_tree, player1Range, player2Range, initialBoard, compairer, deck,
      iteration_number, false, print_interval, logfile_name, algorithm, warmup,
      accuracy, use_isomorphism, threads);
  this->solver->train();
}

void PokerSolver::dump_strategy(std::string dump_file_base, int dump_rounds) {
  json dump_json = this->solver->dumps(false, dump_rounds);
  std::string db_path = dump_file_base + ".sqlite";
  std::remove(db_path.c_str());

  try {
    SQLite::Database db(db_path, SQLite::OPEN_READWRITE | SQLite::OPEN_CREATE);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = OFF;");

    // Create Paths Table: Stores unique paths and assigns an ID
    db.exec("CREATE TABLE paths ("
            "  path_id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "  path_text TEXT NOT NULL UNIQUE"
            ")");

    db.exec("CREATE TABLE nodes ("
            "  path_id INTEGER PRIMARY KEY NOT NULL,"
            "  data BLOB NOT NULL,"
            "  FOREIGN KEY(path_id) REFERENCES paths(path_id)"
            ")");

    SQLite::Statement insertPathStmt(
        db, "INSERT OR IGNORE INTO paths (path_text) VALUES (?)");
    SQLite::Statement selectPathIdStmt(
        db, "SELECT path_id FROM paths WHERE path_text = ?");
    SQLite::Statement insertNodeStmt(
        db, "INSERT INTO nodes (path_id, data) VALUES (?, ?)");

    {
      SQLite::Transaction transaction(db);
      bool compress_data = false;
      storeJsonInDbInterned(insertPathStmt, selectPathIdStmt, insertNodeStmt,
                            dump_json, "", compress_data);
      transaction.commit();
    }

    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("VACUUM;");
  } catch (const std::exception &e) {
    std::remove(db_path.c_str());
    throw std::runtime_error("Failed to write strategy to SQLite DB '" +
                             db_path + "': " + e.what());
  }
  // db connection closes automatically via RAII here
}

const shared_ptr<GameTree> &PokerSolver::getGameTree() const {
  return game_tree;
}

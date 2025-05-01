#ifndef GET_INPUT_H
#define GET_INPUT_H
#include "PokerSolver.h"
#include <fmt/format.h>
#include <fstream>
#include <iostream>
#include <json.hpp>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace std;
using json = nlohmann::json;

class GetInput {
public:
  GetInput(string resource_dir);
  void loadConfigFromJsonFile(const string &json_file_path);
  void buildTreeFromConfig();
  void solveFromConfig();
  void dumpResultFromConfig();

private:
  void applyJsonConfig(const json &config);
  void parseBetSizing(const json &betSizingConfig);

  string resource_dir;
  bool config_loaded_ = false;
  bool tree_built_ = false;
  bool solve_completed_ = false;

  PokerSolver ps;

  float oop_commit = 5;
  float ip_commit = 5;
  int current_round = 1;
  int thread_number = 1;
  float stack = 25;
  float allin_threshold = 0.67;
  string range_ip;
  string range_oop;
  string board;
  float accuracy = 0.5;
  int max_iteration = 200;
  int use_isomorphism = 1;
  int print_interval = 10;
  int dump_rounds = 3;

  float small_blind = 0.5;
  float big_blind = 1;
  int raise_limit = 4;

  shared_ptr<GameTreeBuildingSettings> gtbs;

  string output_filename;
};

#endif // GET_INPUT_H

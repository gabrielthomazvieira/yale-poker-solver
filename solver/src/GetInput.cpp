// GetInput.cpp

#include "GetInput.h"

// Constructor: Initialize PokerSolver and GameTreeBuildingSettings
GetInput::GetInput(string resource_dir) : resource_dir(resource_dir) {
  string suits = "c,d,h,s";
  string ranks = "2,3,4,5,6,7,8,9,T,J,Q,K,A";
  string compairer_file =
      this->resource_dir + "/compairer/card5_dic_sorted.txt";
  int lines = 2598961;

  try {
    this->ps = PokerSolver(ranks, suits, compairer_file, lines);
  } catch (const std::exception &e) {
    cerr << "Error initializing PokerSolver: " << e.what() << endl;
    throw; // Re-throw to indicate critical failure
  }

  // Initialize GameTreeBuildingSettings with default empty StreetSettings
  StreetSetting default_setting({}, {}, {}, false);
  this->gtbs = make_shared<GameTreeBuildingSettings>(
      default_setting, default_setting, default_setting, // IP flop, turn, river
      default_setting, default_setting, default_setting // OOP flop, turn, river
  );
}

// Reads and parses the JSON configuration file, then applies the config
void GetInput::loadConfigFromJsonFile(const string &json_file_path) {
  cout << "Loading configuration from: " << json_file_path << endl;
  std::ifstream ifs(json_file_path);
  if (!ifs.is_open()) {
    throw runtime_error(
        fmt::format("Failed to open JSON config file: {}", json_file_path));
  }

  json configJson;
  try {
    ifs >> configJson;
    cout << "JSON file parsed successfully." << endl;
  } catch (json::parse_error &e) {
    // Provide more context on JSON parsing errors
    throw runtime_error(fmt::format(
        "Failed to parse JSON config file '{}'. Error: {} at byte {}",
        json_file_path, e.what(), e.byte));
  }

  // Apply the configuration from the parsed JSON (sets member variables)
  applyJsonConfig(configJson);

  this->config_loaded_ = true; // Mark config as successfully loaded and applied
  cout << "Configuration applied." << endl;
}

// Applies the configuration loaded from the JSON object (sets member vars only)
void GetInput::applyJsonConfig(const json &config) {
  // Reset state flags in case config is reloaded
  tree_built_ = false;
  solve_completed_ = false;

  // --- Game Setup ---
  if (config.contains("gameSetup")) {
    const auto &gameSetup = config["gameSetup"];
    if (gameSetup.contains("pot") && gameSetup["pot"].is_number()) {
      float pot = gameSetup["pot"].get<float>();
      this->ip_commit = pot / 2.0f;
      this->oop_commit = pot / 2.0f;
    }
    if (gameSetup.contains("effectiveStack") &&
        gameSetup["effectiveStack"].is_number()) {
      this->stack = gameSetup["effectiveStack"].get<float>() + this->ip_commit;
    }
    if (gameSetup.contains("board") && gameSetup["board"].is_array()) {
      vector<string> board_vec = gameSetup["board"].get<vector<string>>();
      std::stringstream ss;
      for (size_t i = 0; i < board_vec.size(); ++i) {
        ss << board_vec[i] << (i == board_vec.size() - 1 ? "" : ",");
      }
      this->board = ss.str();
      // Determine current round based on board size
      if (board_vec.size() == 3)
        this->current_round = 1; // Flop
      else if (board_vec.size() == 4)
        this->current_round = 2; // Turn
      else if (board_vec.size() == 5)
        this->current_round = 3; // River
      else if (board_vec.empty())
        this->current_round = 0; // Preflop
      else {
        throw runtime_error(
            fmt::format("Invalid number of board cards: {}", board_vec.size()));
      }
    }
  }

  // --- Player Ranges ---
  if (config.contains("playerRanges")) {
    const auto &ranges = config["playerRanges"];
    if (ranges.contains("inPosition") && ranges["inPosition"].is_string()) {
      this->range_ip = ranges["inPosition"].get<string>();
    }
    if (ranges.contains("outOfPosition") &&
        ranges["outOfPosition"].is_string()) {
      this->range_oop = ranges["outOfPosition"].get<string>();
    }
  }

  // --- Bet Sizing ---
  if (config.contains("betSizing")) {
    parseBetSizing(config["betSizing"]);
  }

  // --- Solver Settings ---
  if (config.contains("solverSettings")) {
    const auto &settings = config["solverSettings"];
    if (settings.contains("allinThreshold") &&
        settings["allinThreshold"].is_number()) {
      this->allin_threshold = settings["allinThreshold"].get<float>();
    }
    if (settings.contains("threadCount") &&
        settings["threadCount"].is_number_integer()) {
      this->thread_number = settings["threadCount"].get<int>();
    }
    if (settings.contains("accuracyTarget") &&
        settings["accuracyTarget"].is_number()) {
      this->accuracy = settings["accuracyTarget"].get<float>();
    }
    if (settings.contains("maxIterations") &&
        settings["maxIterations"].is_number_integer()) {
      this->max_iteration = settings["maxIterations"].get<int>();
    }
    if (settings.contains("printInterval") &&
        settings["printInterval"].is_number_integer()) {
      this->print_interval = settings["printInterval"].get<int>();
    }
    if (settings.contains("useIsomorphism") &&
        settings["useIsomorphism"].is_boolean()) {
      this->use_isomorphism = settings["useIsomorphism"].get<bool>() ? 1 : 0;
    }
  }

  // --- Output Settings ---
  if (config.contains("outputSettings")) {
    const auto &output = config["outputSettings"];
    if (output.contains("dumpStrategyForRounds") &&
        output["dumpStrategyForRounds"].is_number_integer()) {
      this->dump_rounds = output["dumpStrategyForRounds"].get<int>();
    }
    if (output.contains("outputFileName") &&
        output["outputFileName"].is_string()) {
      this->output_filename = output["outputFileName"].get<string>();
    }
  }
}

// Builds the game tree using loaded configuration
void GetInput::buildTreeFromConfig() {
  if (!config_loaded_) {
    throw runtime_error(
        "Configuration not loaded. Call loadConfigFromJsonFile first.");
  }
  if (tree_built_) {
    cout << "Notice: Game tree already built. Skipping build." << endl;
    return;
  }

  cout << ">>> Building Game Tree <<<" << endl;
  try {
    // Pass the configured parameters to the solver's build function
    this->ps.build_game_tree(this->oop_commit, this->ip_commit,
                             this->current_round, this->raise_limit,
                             this->small_blind, this->big_blind, this->stack,
                             *this->gtbs.get(), this->allin_threshold);

    cout << "  Game tree built successfully." << endl;
    this->tree_built_ = true; // Mark tree as built
  } catch (const std::exception &e) {
    this->tree_built_ = false; // Ensure flag is false on error
    // Re-throw exception to be handled by the caller (main)
    throw runtime_error(fmt::format("Error building game tree: {}", e.what()));
  }
}

// Runs the solver using loaded configuration
void GetInput::solveFromConfig() {
  if (!config_loaded_) {
    throw runtime_error(
        "Configuration not loaded. Call loadConfigFromJsonFile first.");
  }
  if (!tree_built_) {
    throw runtime_error("Game tree not built. Call buildTreeFromConfig first.");
  }
  if (solve_completed_) {
    cout << "Notice: Solver already run. Skipping solve." << endl;
    return; // Prevent redundant solves
  }
  if (this->range_ip.empty() || this->range_oop.empty()) {
    throw runtime_error("Cannot start solve. Player ranges not set in config.");
  }

  cout << ">>> Starting Solver <<<" << endl;
  cout << "  Max Iterations: " << this->max_iteration
       << ", Accuracy Target: " << std::fixed << std::setprecision(8)
       << this->accuracy << endl;
  try {
    this->ps.train(this->range_ip, this->range_oop, this->board,
                   "tmp_log.txt",
                   this->max_iteration, this->print_interval,
                   "discounted_cfr",
                   -1,
                   this->accuracy, this->use_isomorphism, this->thread_number);
    cout << "  Solver finished." << endl;
    this->solve_completed_ = true;
  } catch (const std::exception &e) {
    this->solve_completed_ = false;
    throw runtime_error(
        fmt::format("Error during solver training: {}", e.what()));
  }
}

// Dumps the results after solving
void GetInput::dumpResultFromConfig() {
  if (!config_loaded_) {
    throw runtime_error("Configuration not loaded.");
  }
  if (!solve_completed_) {
    cerr << "Warning: Solver has not completed successfully. Dumping "
            "potentially incomplete results."
         << endl;
  }
  if (this->output_filename.empty()) {
    throw runtime_error(
        "Output filename not specified in configuration. Cannot dump results.");
  }

  cout << ">>> Dumping Result <<<" << endl;
  try {
    this->ps.dump_strategy(this->output_filename, this->dump_rounds);
    cout << "  Results dumped to " << this->output_filename << endl;
  } catch (const std::exception &e) {
    throw runtime_error(fmt::format("Error dumping results: {}", e.what()));
  }
}

// Helper function to parse the nested bet sizing structure
void GetInput::parseBetSizing(const json &betSizingConfig) {
  vector<string> players_json = {"inPosition", "outOfPosition"};
  vector<string> streets = {"flop", "turn", "river"};

  for (const auto &player_json_key : players_json) {
    if (!betSizingConfig.contains(player_json_key))
      continue;
    const auto &playerConfig = betSizingConfig[player_json_key];

    // Map JSON key to internal key expected by get_setting
    string internal_player_name;
    if (player_json_key == "inPosition")
      internal_player_name = "ip";
    else if (player_json_key == "outOfPosition")
      internal_player_name = "oop";
    else
      continue; // Should not occur

    for (const auto &street : streets) {
      if (!playerConfig.contains(street))
        continue;
      if (!playerConfig[street].is_array())
        continue;

      try {
        // Get reference to the correct StreetSetting object
        StreetSetting &streetSetting =
            this->gtbs->get_setting(internal_player_name, street);

        // Clear defaults before applying JSON settings for this street
        streetSetting.bet_sizes.clear();
        streetSetting.raise_sizes.clear();
        streetSetting.donk_sizes.clear();
        streetSetting.allin = false;

        // Process each action defined for this street
        for (const auto &actionItem : playerConfig[street]) {
          if (!actionItem.is_object() || !actionItem.contains("action") ||
              !actionItem["action"].is_string())
            continue;

          string action = actionItem["action"].get<string>();
          vector<float> *target_sizes = nullptr;

          if (action == "allin") {
            streetSetting.allin = true;
          } else {
            // Assign target_sizes pointer based on action type
            if (action == "bet")
              target_sizes = &streetSetting.bet_sizes;
            else if (action == "raise")
              target_sizes = &streetSetting.raise_sizes;
            else if (action == "donk")
              target_sizes = &streetSetting.donk_sizes;
            else {
              cerr << "Warning: Unknown bet action type '" << action
                   << "' in JSON config for " << player_json_key << "/"
                   << street << endl;
              continue;
            }

            // Check and parse the sizes array
            if (!actionItem.contains("sizes") ||
                !actionItem["sizes"].is_array()) {
              cerr << "Warning: Missing or invalid 'sizes' array for action '"
                   << action << "' in JSON config for " << player_json_key
                   << "/" << street << endl;
              continue;
            }
            // Populate the target size vector
            for (const auto &sizeVal : actionItem["sizes"]) {
              if (sizeVal.is_number()) {
                target_sizes->push_back(sizeVal.get<float>());
              } else {
                cerr << "Warning: Non-numeric value found in 'sizes' array for "
                        "action '"
                     << action << "' in JSON config for " << player_json_key
                     << "/" << street << endl;
              }
            }
          }
        }
      } catch (const std::runtime_error &e) {
        cerr << "Error processing bet sizing for " << internal_player_name
             << "/" << street << ": " << e.what() << endl;
      }
    }
  }
}
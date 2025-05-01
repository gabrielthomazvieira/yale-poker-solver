#ifndef GAME_TREE_H
#define GAME_TREE_H

#include "CardsUtils.h"
#include "json.hpp"
#include "library.h"
#include <Nodes.h>
#include <fstream>
#include <vector>

using json = nlohmann::json;

class GameTreeBuildingSettings;
class StreetSetting;
class Rule;

class GameTree {
private:
  string tree_json_dir;
  shared_ptr<GameTreeNode> root = nullptr;
  Deck deck;
  enum BetType { BET, DONK, RAISE };

public:
  GameTree(const string &tree_json_dir, Deck deck);
  GameTree(Deck deck, float oop_commit, float ip_commit, int current_round,
           int raise_limit, float small_blind, float big_blind, float stack,
           GameTreeBuildingSettings buildingSettings, float allin_threshold);
  shared_ptr<GameTreeNode> __build(shared_ptr<GameTreeNode> node, Rule rule);
  shared_ptr<GameTreeNode> __build(shared_ptr<GameTreeNode> node, Rule rule,
                                   string last_action, int check_times,
                                   int raise_times);
  void buildChance(shared_ptr<ChanceNode> root, Rule rule);
  void buildAction(shared_ptr<ActionNode> root, Rule rule, string last_action,
                   int check_times, int raise_times);
  shared_ptr<GameTreeNode> getRoot();
  vector<double> get_possible_bets(shared_ptr<ActionNode> root, int player,
                                   int next_player, Rule rule, BetType betType);
  double round_nearest(double number, double round_num);
  StreetSetting getSettings(int int_round, int player,
                            GameTreeBuildingSettings &gameTreeBuildingSettings);
  static ifstream readAllBytes(const string &filePath);
  static GameTreeNode::GameRound strToGameRound(const string &round);
  static void recurrentPrintTree(const shared_ptr<GameTreeNode> &node,
                                 int depth, int depth_limit);
  shared_ptr<GameTreeNode>
  recurrentGenerateTreeNode(json node_json,
                            const shared_ptr<GameTreeNode> &parent);
  shared_ptr<ActionNode> generateActionNode(json meta,
                                            vector<string> childrens_actions,
                                            vector<json> childrens_nodes,
                                            const string &round,
                                            shared_ptr<GameTreeNode> parent);
  shared_ptr<ChanceNode> generateChanceNode(json meta, const json &child,
                                            string round,
                                            shared_ptr<GameTreeNode> parent);
  static shared_ptr<ShowdownNode>
  generateShowdownNode(json meta, string round,
                       shared_ptr<GameTreeNode> parent);
  shared_ptr<TerminalNode>
  generateTerminalNode(json meta, string round,
                       shared_ptr<GameTreeNode> parent);
  void printTree(int depth);

private:
  int recurrentSetDepth(shared_ptr<GameTreeNode> node, int depth);
};

class StreetSetting {
public:
  vector<float> bet_sizes;
  vector<float> raise_sizes;
  vector<float> donk_sizes;
  bool allin;

  StreetSetting(vector<float> bet_sizes, vector<float> raise_sizes,
                vector<float> donk_sizes, bool allin);
};

class GameTreeBuildingSettings {
public:
  GameTreeBuildingSettings(StreetSetting flop_ip, StreetSetting turn_ip,
                           StreetSetting river_ip, StreetSetting flop_oop,
                           StreetSetting turn_oop, StreetSetting river_oop);
  StreetSetting flop_ip;
  StreetSetting turn_ip;
  StreetSetting river_ip;
  StreetSetting flop_oop;
  StreetSetting turn_oop;
  StreetSetting river_oop;
  StreetSetting &get_setting(string player, string round);
};

class Rule {
public:
  Deck &deck;
  float oop_commit;
  float ip_commit;
  int current_round;
  int raise_limit;
  float small_blind;
  float big_blind;
  float stack;
  GameTreeBuildingSettings build_settings;
  vector<int> players = {0, 1};
  float allin_threshold;
  float initial_effective_stack;
  Rule(Deck deck, float oop_commit, float ip_commit, int current_round,
       int raise_limit, float small_blind, float big_blind, float stack,
       GameTreeBuildingSettings build_settings, float allin_threshold);

  float get_pot();
  float get_commit(int player);
};

#endif // GAME_TREE_H

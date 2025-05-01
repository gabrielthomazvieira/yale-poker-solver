#ifndef NODES_H
#define NODES_H
#include "CardsUtils.h"
#include "fmt/format.h"
#include <mutex>
#include <Ranges.h>
#include <string>
#include <thread>
#include <vector>

using namespace std;

class DiscountedCfr;

class GameTreeNode {
public:
  enum PokerActions { BEGIN, ROUNDBEGIN, BET, RAISE, CHECK, FOLD, CALL };

  enum GameTreeNodeType { ACTION, SHOWDOWN, TERMINAL, CHANCE };

  enum GameRound { PREFLOP, FLOP, TURN, RIVER };
  GameTreeNode();
  GameTreeNode(GameRound round, double pot, shared_ptr<GameTreeNode> parent);
  static GameTreeNode::GameRound intToGameRound(int round);
  int depth{};
  int subtree_size{};
  static int gameRound2int(GameRound gameRound);
  shared_ptr<GameTreeNode> getParent();
  void setParent(shared_ptr<GameTreeNode> parent);
  GameRound getRound();
  double getPot();
  void printHistory();
  static void printNodeHistory(GameTreeNode *node);
  virtual GameTreeNodeType getType() = 0;

private:
  GameRound round;
  double pot{};
  shared_ptr<GameTreeNode> parent;
};

class GameActions {
public:
  GameActions();
  GameTreeNode::PokerActions getAction();
  double getAmount();
  GameActions(GameTreeNode::PokerActions action, double amount);
  string toString();
  string pokerActionToString(GameTreeNode::PokerActions pokerActions);

private:
  GameTreeNode::PokerActions action;
  double amount{};
};

class ActionNode : public GameTreeNode {
public:
  ActionNode(vector<GameActions> actions,
             vector<shared_ptr<GameTreeNode>> childrens, int player,
             GameRound round, double pot, shared_ptr<GameTreeNode> parent);
  vector<GameActions> &getActions();
  vector<shared_ptr<GameTreeNode>> &getChildrens();
  int getPlayer();
  shared_ptr<DiscountedCfr> getTrainable(int i, bool create_on_site = true);
  void setTrainable(vector<shared_ptr<DiscountedCfr>> trainable,
                    vector<PrivateCards> *player_privates);
  vector<PrivateCards> *player_privates;

private:
  GameTreeNodeType getType() override;

private:
  vector<GameActions> actions;

public:
  void setActions(const vector<GameActions> &actions);

  void setChildrens(const vector<shared_ptr<GameTreeNode>> &childrens);

private:
  vector<shared_ptr<GameTreeNode>> childrens;
  vector<shared_ptr<DiscountedCfr>> trainables;
  int player;
};

class ChanceNode : public GameTreeNode {
public:
  ChanceNode(const shared_ptr<GameTreeNode> children, GameRound round,
             double pot, shared_ptr<GameTreeNode> parent,
             const vector<Card> &cards, bool donk = false);
  const vector<Card> &getCards();
  shared_ptr<GameTreeNode> getChildren();
  void setChildren(shared_ptr<GameTreeNode> children);
  int getPlayer();
  bool isDonk();

private:
  GameTreeNodeType getType() override;
  shared_ptr<GameTreeNode> children;
  int player{};
  const vector<Card> &cards;
  bool donk;
};

class ShowdownNode : public GameTreeNode {
public:
  enum ShowDownResult { NOTTIE, TIE };
  GameTreeNodeType getType() override;
  ShowdownNode(vector<double> tie_payoffs,
               vector<vector<double>> player_payoffs, GameRound round,
               double pot, shared_ptr<GameTreeNode> parent);
  vector<double> get_payoffs(ShowDownResult result, int winner);
  double get_payoffs(ShowDownResult result, int winner, int player);

private:
  vector<double> tie_payoffs;
  vector<vector<double>> player_payoffs;
};

class TerminalNode : public GameTreeNode {
public:
  TerminalNode();
  TerminalNode(vector<double> payoffs, int winner,
               GameTreeNode::GameRound round, double pot,
               shared_ptr<GameTreeNode> parent);
  vector<double> get_payoffs();

private:
  GameTreeNodeType getType() override;

private:
  vector<double> payoffs;
  int winner{};
};

#endif // NODES_H

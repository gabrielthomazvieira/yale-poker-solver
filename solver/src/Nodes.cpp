#include "Nodes.h"
#include "Solver.h"
#include <utility>

GameTreeNode::GameTreeNode() {}

GameTreeNode::GameTreeNode(GameTreeNode::GameRound round, double pot,
                           shared_ptr<GameTreeNode> parent) {
  this->round = round;
  this->pot = pot;
  this->parent = std::move(parent);
}

int GameTreeNode::gameRound2int(GameTreeNode::GameRound gameRound) {
  if (gameRound == GameRound::PREFLOP) {
    return 0;
  } else if (gameRound == GameRound::FLOP) {
    return 1;
  } else if (gameRound == GameRound::TURN) {
    return 2;
  } else if (gameRound == GameRound::RIVER) {
    return 3;
  }
  throw runtime_error("round not found");
}

shared_ptr<GameTreeNode> GameTreeNode::getParent() { return this->parent; }

void GameTreeNode::setParent(shared_ptr<GameTreeNode> parent) {
  this->parent = parent;
}

GameTreeNode::GameRound GameTreeNode::getRound() { return this->round; }

double GameTreeNode::getPot() { return this->pot; }

void GameTreeNode::printHistory() {
}

GameTreeNode::GameRound GameTreeNode::intToGameRound(int round) {
  GameTreeNode::GameRound game_round;
  switch (round) {
  case 0: {
    game_round = GameTreeNode::GameRound::PREFLOP;
    break;
  }
  case 1: {
    game_round = GameTreeNode::GameRound::FLOP;
    break;
  }
  case 2: {
    game_round = GameTreeNode::GameRound::TURN;
    break;
  }
  case 3: {
    game_round = GameTreeNode::GameRound::RIVER;
    break;
  }
  default: {
    throw runtime_error(fmt::format("round %s not found", round));
  }
  }
  return game_round;
}

void GameTreeNode::printNodeHistory(GameTreeNode *node) {}

ActionNode::ActionNode(vector<GameActions> actions,
                       vector<shared_ptr<GameTreeNode>> childrens, int player,
                       GameTreeNode::GameRound round, double pot,
                       shared_ptr<GameTreeNode> parent)
    : GameTreeNode(round, pot, std::move(parent)) {
  this->actions = std::move(actions);
  this->player = player;
  this->childrens = std::move(childrens);
}

vector<GameActions> &ActionNode::getActions() { return this->actions; }

vector<shared_ptr<GameTreeNode>> &ActionNode::getChildrens() {
  return this->childrens;
}

int ActionNode::getPlayer() { return this->player; }

GameTreeNode::GameTreeNodeType ActionNode::getType() { return ACTION; }

shared_ptr<DiscountedCfr> ActionNode::getTrainable(int i, bool create_on_site) {
  if (i > this->trainables.size()) {
    throw runtime_error(
        fmt::format("size unacceptable {} > {} ", i, this->trainables.size()));
  }
  if (this->trainables[i] == nullptr && create_on_site) {
    this->trainables[i] = make_shared<DiscountedCfr>(player_privates, *this);
  }
  return this->trainables[i];
}

void ActionNode::setTrainable(vector<shared_ptr<DiscountedCfr>> trainables,
                              vector<PrivateCards> *player_privates) {
  this->trainables = trainables;
  this->player_privates = player_privates;
}

void ActionNode::setActions(const vector<GameActions> &actions) {
  ActionNode::actions = actions;
}

void ActionNode::setChildrens(
    const vector<shared_ptr<GameTreeNode>> &childrens) {
  ActionNode::childrens = childrens;
}

GameActions::GameActions() = default;

GameTreeNode::PokerActions GameActions::getAction() { return this->action; }

double GameActions::getAmount() { return this->amount; }

GameActions::GameActions(GameTreeNode::PokerActions action, double amount) {
  this->action = action;
  if (action == GameTreeNode::PokerActions::RAISE ||
      action == GameTreeNode::PokerActions::BET) {
    if (amount == -1)
      throw runtime_error(
          fmt::format("raise/bet amount should not be -1, find {}", amount));
  } else {
    if (amount != -1)
      throw runtime_error(
          fmt::format("check/fold/call amount should be -1, find {}", amount));
  }
  this->amount = amount;
}

string
GameActions::pokerActionToString(GameTreeNode::PokerActions pokerActions) {
  switch (pokerActions) {
  case GameTreeNode::PokerActions::BEGIN:
    return "BEGIN";
  case GameTreeNode::PokerActions::ROUNDBEGIN:
    return "ROUNDBEGIN";
  case GameTreeNode::PokerActions::BET:
    return "BET";
  case GameTreeNode::PokerActions::RAISE:
    return "RAISE";
  case GameTreeNode::PokerActions::CHECK:
    return "CHECK";
  case GameTreeNode::PokerActions::FOLD:
    return "FOLD";
  case GameTreeNode::PokerActions::CALL:
    return "CALL";
  default: {
    throw runtime_error("PokerActions not found");
  }
  }
}

string GameActions::toString() {
  if (this->amount == -1) {
    return this->pokerActionToString(this->action);
  } else {
    return this->pokerActionToString(this->action) + " " + to_string(amount);
  }
}

TerminalNode::TerminalNode() {}

TerminalNode::TerminalNode(vector<double> payoffs, int winner,
                           GameTreeNode::GameRound round, double pot,
                           shared_ptr<GameTreeNode> parent)
    : GameTreeNode(round, pot, parent) {
  this->payoffs = payoffs;
  this->winner = winner;
}

vector<double> TerminalNode::get_payoffs() { return this->payoffs; }

GameTreeNode::GameTreeNodeType TerminalNode::getType() { return TERMINAL; }

ChanceNode::ChanceNode(const shared_ptr<GameTreeNode> children,
                       GameTreeNode::GameRound round, double pot,
                       shared_ptr<GameTreeNode> parent,
                       const vector<Card> &cards, bool donk)
    : GameTreeNode(round, pot, std::move(parent)), cards(cards) {
  this->children = children;
  this->donk = donk;
}

const vector<Card> &ChanceNode::getCards() { return this->cards; }

shared_ptr<GameTreeNode> ChanceNode::getChildren() { return this->children; }

void ChanceNode::setChildren(shared_ptr<GameTreeNode> children) {
  this->children = children;
}

int ChanceNode::getPlayer() { return this->player; }

GameTreeNode::GameTreeNodeType ChanceNode::getType() { return CHANCE; }

bool ChanceNode::isDonk() { return this->donk; }

ShowdownNode::ShowdownNode(vector<double> tie_payoffs,
                           vector<vector<double>> player_payoffs,
                           GameTreeNode::GameRound round, double pot,
                           shared_ptr<GameTreeNode> parent)
    : GameTreeNode(round, pot, std::move(parent)) {
  this->tie_payoffs = std::move(tie_payoffs);
  this->player_payoffs = std::move(player_payoffs);
}

double ShowdownNode::get_payoffs(ShowdownNode::ShowDownResult result,
                                 int winner, int player) {
  if (result == ShowDownResult::NOTTIE) {
    if (winner == -1)
      throw runtime_error("winner == -1 in tie");
    return player_payoffs[winner][player];
  } else {
    if (winner != -1)
      throw runtime_error("winner != -1 in not tie");
    return this->tie_payoffs[player];
  }
}

vector<double> ShowdownNode::get_payoffs(ShowdownNode::ShowDownResult result,
                                         int winner) {
  if (result == ShowDownResult::NOTTIE) {
    if (winner == -1)
      throw runtime_error("winner == -1 in tie");
    vector<double> retval = player_payoffs[winner];
    return retval;
  } else {
    if (winner != -1)
      throw runtime_error("winner != -1 in not tie");
    return this->tie_payoffs;
  }
}

GameTreeNode::GameTreeNodeType ShowdownNode::getType() { return SHOWDOWN; }

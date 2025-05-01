#ifndef RANGES_H
#define RANGES_H

#include "CardsUtils.h"
#include "library.h"
#include <DictRanker.h>
#include <HandRanker.h>
#include <mutex>
#include <unordered_map>

class PrivateCards {
public:
  int card1{};
  int card2{};
  float weight{};
  float relative_prob{};
  PrivateCards();
  PrivateCards(int card1, int card2, float weight);
  uint64_t toBoardLong();
  int hashCode();
  string toString();
  const vector<int> &get_hands() const;

private:
  vector<int> card_vec;
  int hash_code{};
  uint64_t board_long;
};

class PrivateCardsManager {
private:
  vector<vector<PrivateCards>> private_cards;
  int player_number;
  uint64_t initialboard;
  vector<vector<int>> card_player_index;

public:
  PrivateCardsManager();
  PrivateCardsManager(vector<vector<PrivateCards>> private_cards,
                      int player_number, uint64_t initialboard);
  vector<PrivateCards> &getPreflopCards(int player);
  int indPlayer2Player(int from_player, int to_player, int index);
  vector<float> getInitialReachProb(int player, uint64_t initialboard);
  void setRelativeProbs();
};

class RiverCombs {
public:
  int rank;
  PrivateCards private_cards;
  int reach_prob_index;
  RiverCombs();
  RiverCombs(vector<int> board, PrivateCards private_cards, int rank,
             int reach_prob_index);

private:
  vector<int> board;
};

class RiverRangeManager {
public:
  RiverRangeManager();
  RiverRangeManager(shared_ptr<HandRanker> handEvaluator);
  const vector<RiverCombs> &
  getRiverCombos(int player, const vector<PrivateCards> &riverCombos,
                 const vector<int> &board);
  const vector<RiverCombs> &
  getRiverCombos(int player, const vector<PrivateCards> &riverCombos,
                 uint64_t board_long);

private:
  unordered_map<uint64_t, vector<RiverCombs>> p1RiverRanges;
  unordered_map<uint64_t, vector<RiverCombs>> p2RiverRanges;
  shared_ptr<HandRanker> handEvaluator;
  shared_ptr<mutex> maplock;
};

class PrivateRangeConverter {
public:
  static vector<PrivateCards> rangeStr2Cards(string range_str,
                                             vector<int> initial_boards);
};

#endif // RANGES_H
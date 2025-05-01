#ifndef SOLVER_H
#define SOLVER_H

#include "CardsUtils.h"
#include "lookup8.h"
#include "utils.h"
#include <CardsUtils.h>
#include <GameTree.h>
#include <HandRanker.h>
#include <Nodes.h>
#include <Ranges.h>
#include <algorithm>
#include <cctype>
#include <iomanip>
#include <json.hpp>
#include <numeric>
#include <omp.h>
#include <optional>
#include <queue>
#include <regex>
#include <sstream>
#include <utils.h>
using namespace std;
using json = nlohmann::json;

class Solver {
public:
  Solver();
  Solver(shared_ptr<GameTree> tree);
  shared_ptr<GameTree> getTree();
  virtual void train() = 0;
  virtual json dumps(bool with_status, int depth) = 0;
  shared_ptr<GameTree> tree;
};

template <typename T> class ThreadsafeQueue {
  std::queue<T> queue_;
  mutable std::mutex mutex_;

  bool empty() const { return queue_.empty(); }

public:
  ThreadsafeQueue() = default;
  ThreadsafeQueue(const ThreadsafeQueue<T> &) = delete;
  ThreadsafeQueue &operator=(const ThreadsafeQueue<T> &) = delete;

  ThreadsafeQueue(ThreadsafeQueue<T> &&other) {
    std::lock_guard<std::mutex> lock(mutex_);
    queue_ = std::move(other.queue_);
  }

  virtual ~ThreadsafeQueue() {}

  unsigned long size() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return queue_.size();
  }

  std::optional<T> pop() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (queue_.empty()) {
      return {};
    }
    T tmp = queue_.front();
    queue_.pop();
    return tmp;
  }

  void push(const T &item) {
    std::lock_guard<std::mutex> lock(mutex_);
    queue_.push(item);
  }
};

struct TaskParams {
  int player;
  shared_ptr<GameTreeNode> node;
  const vector<float> &reach_probs;
  int iter;
  uint64_t current_board;
  int deal;
};

class DCfrSolver : public Solver {
public:
  DCfrSolver(shared_ptr<GameTree> tree, vector<PrivateCards> range1,
             vector<PrivateCards> range2, vector<int> initial_board,
             shared_ptr<HandRanker> compairer, Deck deck, int iteration_number,
             bool debug, int print_interval, string logfile, string trainer,
             int warmup, float accuracy, bool use_isomorphism, int num_threads);
  void train() override;
  json dumps(bool with_status, int depth);

private:
  vector<vector<PrivateCards>> ranges;
  vector<PrivateCards> range1;
  vector<PrivateCards> range2;
  vector<int> initial_board;
  uint64_t initial_board_long;
  shared_ptr<HandRanker> compairer;
  int color_iso_offset[52 * 52 * 2][4] = {0};

  Deck deck;
  RiverRangeManager rrm;
  int player_number;
  int iteration_number;
  PrivateCardsManager pcm;
  bool debug;
  int print_interval;
  string trainer;
  string logfile;
  vector<int> round_deal;
  int num_threads;
  int warmup;
  GameTreeNode::GameRound root_round;
  GameTreeNode::GameRound split_round;
  bool distributing_task;
  float accuracy;
  bool use_isomorphism;

  const vector<PrivateCards> &playerHands(int player);
  vector<vector<float>> getReachProbs();
  static vector<PrivateCards>
  noDuplicateRange(const vector<PrivateCards> &private_range,
                   uint64_t board_long);
  void setTrainable(shared_ptr<GameTreeNode> root);
  vector<float> cfr(int player, shared_ptr<GameTreeNode> node,
                    const vector<float> &reach_probs, int iter,
                    uint64_t current_board, int deal);
  vector<int> getAllAbstractionDeal(int deal);
  vector<float> chanceUtility(int player, shared_ptr<ChanceNode> node,
                              const vector<float> &reach_probs, int iter,
                              uint64_t current_boardi, int deal);
  vector<float> showdownUtility(int player, shared_ptr<ShowdownNode> node,
                                const vector<float> &reach_probs, int iter,
                                uint64_t current_board, int deal);
  vector<float> actionUtility(int player, shared_ptr<ActionNode> node,
                              const vector<float> &reach_probs, int iter,
                              uint64_t current_board, int deal);
  vector<float> terminalUtility(int player, shared_ptr<TerminalNode> node,
                                const vector<float> &reach_prob, int iter,
                                uint64_t current_board, int deal);
  void findGameSpecificIsomorphisms();
  void exchangeRange(json &strategy, int rank1, int rank2,
                     shared_ptr<ActionNode> one_node);
  void reConvertJson(const shared_ptr<GameTreeNode> &node, json &strategy,
                     string key, int depth, int max_depth,
                     vector<string> prefix, int deal,
                     vector<vector<int>> exchange_color_list);
};

class BestResponse {
private:
  Deck &deck;
  vector<vector<PrivateCards>> &private_combos;
  vector<int> player_hands;
  int player_number;
  RiverRangeManager &rrm;
  PrivateCardsManager &pcm;
  bool debug;
  vector<vector<float>> reach_probs;
  int nthreads;

public:
  BestResponse(vector<vector<PrivateCards>> &private_combos, int player_number,
               PrivateCardsManager &pcm, RiverRangeManager &rrm, Deck &deck,
               bool debug, int color_iso_offset[][4],
               GameTreeNode::GameRound split_round, int nthreads = 1);
  float printExploitability(shared_ptr<GameTreeNode> root, int iterationCount,
                            float initial_pot, uint64_t initialBoard);
  float getBestReponseEv(shared_ptr<GameTreeNode> node, int player,
                         vector<vector<float>> reach_probs,
                         uint64_t initialBoard, int deal);

private:
  vector<float> bestResponse(shared_ptr<GameTreeNode> node, int player,
                             const vector<vector<float>> &reach_probs,
                             uint64_t board, int deal);
  vector<float> chanceBestReponse(shared_ptr<ChanceNode> node, int player,
                                  const vector<vector<float>> &reach_probs,
                                  uint64_t current_board, int deal);
  vector<float> actionBestResponse(shared_ptr<ActionNode> node, int player,
                                   const vector<vector<float>> &reach_probs,
                                   uint64_t board, int deal);
  vector<float> terminalBestReponse(shared_ptr<TerminalNode> node, int player,
                                    const vector<vector<float>> &reach_probs,
                                    uint64_t board, int deal);
  vector<float> showdownBestResponse(shared_ptr<ShowdownNode> node, int player,
                                     const vector<vector<float>> &reach_probs,
                                     uint64_t board, int deal);
  int color_iso_offset[52 * 52 * 2][4];
  GameTreeNode::GameRound split_round;
};

class DiscountedCfr {
private:
  ActionNode &action_node;
  vector<PrivateCards> *privateCards;
  int action_number;
  int card_number;
  vector<float> r_plus;
  constexpr static float alpha = 1.5f;
  constexpr static float beta = 0.5f;
  constexpr static float gamma = 2;
  constexpr static float theta = 0.9f;
  vector<float> r_plus_sum;
  vector<float> cum_r_plus;
  vector<float> last_ev;

public:
  DiscountedCfr(vector<PrivateCards> *privateCards, ActionNode &actionNode);
  bool isAllZeros(const vector<float> &input_array);

  const vector<float> getAverageStrategy();

  const vector<float> getcurrentStrategy();

  void updateRegrets(const vector<float> &regrets, int iteration_number,
                     const vector<float> &reach_probs);

  void copyStrategy(shared_ptr<DiscountedCfr> other_trainable);

  json dump_strategy(bool with_state);

  void setLastEV(const vector<float> &ev);

private:
  const vector<float> getcurrentStrategyNoCache();
};

#endif // SOLVER_H

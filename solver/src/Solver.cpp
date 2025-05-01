#include "Solver.h"

Solver::Solver() {}

Solver::Solver(shared_ptr<GameTree> tree) { this->tree = tree; }

shared_ptr<GameTree> Solver::getTree() { return this->tree; }

DCfrSolver::DCfrSolver(shared_ptr<GameTree> tree, vector<PrivateCards> range1,
                       vector<PrivateCards> range2, vector<int> initial_board,
                       shared_ptr<HandRanker> compairer, Deck deck,
                       int iteration_number, bool debug, int print_interval,
                       string logfile, string trainer, int warmup,
                       float accuracy, bool use_isomorphism, int num_threads)
    : Solver(tree) {
  this->initial_board = initial_board;
  this->initial_board_long = Card::boardInts2long(initial_board);
  this->logfile = logfile;
  this->trainer = trainer;
  this->warmup = warmup;

  range1 = this->noDuplicateRange(range1, initial_board_long);
  range2 = this->noDuplicateRange(range2, initial_board_long);

  this->range1 = range1;
  this->range2 = range2;
  this->player_number = 2;
  this->ranges = vector<vector<PrivateCards>>(this->player_number);
  this->ranges[0] = range1;
  this->ranges[1] = range2;

  this->compairer = compairer;

  this->deck = deck;
  this->use_isomorphism = use_isomorphism;

  this->rrm = RiverRangeManager(compairer);
  this->iteration_number = iteration_number;

  vector<vector<PrivateCards>> private_cards(this->player_number);
  private_cards[0] = range1;
  private_cards[1] = range2;
  pcm = PrivateCardsManager(private_cards, this->player_number,
                            Card::boardInts2long(this->initial_board));
  this->debug = debug;
  this->print_interval = print_interval;
  this->accuracy = accuracy;
  if (num_threads == -1) {
    num_threads = omp_get_num_procs();
  }
  cout << fmt::format("Using {} threads", num_threads) << endl;
  this->num_threads = num_threads;
  this->distributing_task = false;
  omp_set_num_threads(this->num_threads);
  omp_set_dynamic(0);
  setTrainable(this->tree->getRoot());
  this->root_round = this->tree->getRoot()->getRound();
  if (this->root_round == GameTreeNode::GameRound::PREFLOP) {
    this->split_round = GameTreeNode::GameRound::FLOP;
  } else if (this->root_round == GameTreeNode::GameRound::FLOP) {
    this->split_round = GameTreeNode::GameRound::TURN;
  } else if (this->root_round == GameTreeNode::GameRound::TURN) {
    this->split_round = GameTreeNode::GameRound::RIVER;
  } else {
    this->split_round = GameTreeNode::GameRound::PREFLOP;
  }
}

const vector<PrivateCards> &DCfrSolver::playerHands(int player) {
  if (player == 0) {
    return range1;
  } else if (player == 1) {
    return range2;
  } else {
    throw runtime_error("player not found");
  }
}

vector<vector<float>> DCfrSolver::getReachProbs() {
  vector<vector<float>> retval(this->player_number);
  for (int player = 0; player < this->player_number; player++) {
    vector<PrivateCards> player_cards = this->playerHands(player);
    vector<float> reach_prob(player_cards.size());
    for (int i = 0; i < player_cards.size(); i++) {
      reach_prob[i] = player_cards[i].weight;
    }
    retval[player] = reach_prob;
  }
  return retval;
}

vector<PrivateCards>
DCfrSolver::noDuplicateRange(const vector<PrivateCards> &private_range,
                             uint64_t board_long) {
  vector<PrivateCards> range_array;
  unordered_map<int, bool> rangekv;
  for (PrivateCards one_range : private_range) {
    if (rangekv.find(one_range.hashCode()) != rangekv.end())
      throw runtime_error(
          fmt::format("duplicated key {}", one_range.toString()));
    rangekv[one_range.hashCode()] = true;
    uint64_t hand_long = Card::boardInts2long(one_range.get_hands());
    if (!Card::boardsHasIntercept(hand_long, board_long)) {
      range_array.push_back(one_range);
    }
  }
  return range_array;
}

void DCfrSolver::setTrainable(shared_ptr<GameTreeNode> root) {
  if (root->getType() == GameTreeNode::ACTION) {
    shared_ptr<ActionNode> action_node =
        std::dynamic_pointer_cast<ActionNode>(root);

    int player = action_node->getPlayer();

    if (this->trainer == "cfr_plus") {
      throw runtime_error(
          fmt::format("trainer {} not supported", this->trainer));
    } else if (this->trainer == "discounted_cfr") {
      vector<PrivateCards> *player_privates = &this->ranges[player];
      int num;
      GameTreeNode::GameRound gr = this->tree->getRoot()->getRound();
      int root_round = GameTreeNode::gameRound2int(gr);
      int current_round = GameTreeNode::gameRound2int(root->getRound());
      int gap = current_round - root_round;

      if (gap == 2) {
        num = this->deck.getCards().size() * this->deck.getCards().size() +
              this->deck.getCards().size() + 1;
      } else if (gap == 1) {
        num = this->deck.getCards().size() + 1;
      } else if (gap == 0) {
        num = 1;
      } else {
        throw runtime_error("gap not understand");
      }
      action_node->setTrainable(vector<shared_ptr<DiscountedCfr>>(num),
                                player_privates);
    } else {
      throw runtime_error(fmt::format("trainer {} not found", this->trainer));
    }

    vector<shared_ptr<GameTreeNode>> children = action_node->getChildrens();
    for (shared_ptr<GameTreeNode> one_child : children)
      setTrainable(one_child);
  } else if (root->getType() == GameTreeNode::CHANCE) {
    shared_ptr<ChanceNode> chance_node =
        std::dynamic_pointer_cast<ChanceNode>(root);
    shared_ptr<GameTreeNode> children = chance_node->getChildren();
    setTrainable(children);
  } else if (root->getType() == GameTreeNode::TERMINAL) {
  } else if (root->getType() == GameTreeNode::SHOWDOWN) {
  }
}

vector<int> DCfrSolver::getAllAbstractionDeal(int deal) {
  vector<int> all_deal;
  int card_num = this->deck.getCards().size();
  if (deal == 0) {
    all_deal.push_back(deal);
  } else if (deal > 0 && deal <= card_num) {
    int origin_deal = int((deal - 1) / 4) * 4;
    for (int i = 0; i < 4; i++) {
      int one_card = origin_deal + i + 1;

      Card *first_card =
          const_cast<Card *>(&(this->deck.getCards()[origin_deal + i]));
      uint64_t first_long = Card::boardInt2long(first_card->getCardInt());
      if (Card::boardsHasIntercept(first_long, this->initial_board_long))
        continue;
      all_deal.push_back(one_card);
    }
  } else {
    int c_deal = deal - (1 + card_num);
    int first_deal = int((c_deal / card_num) / 4) * 4;
    int second_deal = int((c_deal % card_num) / 4) * 4;

    for (int i = 0; i < 4; i++) {
      for (int j = 0; j < 4; j++) {
        if (first_deal == second_deal && i == j)
          continue;

        Card *first_card =
            const_cast<Card *>(&(this->deck.getCards()[first_deal + i]));
        uint64_t first_long = Card::boardInt2long(first_card->getCardInt());
        if (Card::boardsHasIntercept(first_long, this->initial_board_long))
          continue;

        Card *second_card =
            const_cast<Card *>(&(this->deck.getCards()[second_deal + j]));
        uint64_t second_long = Card::boardInt2long(second_card->getCardInt());
        if (Card::boardsHasIntercept(second_long, this->initial_board_long))
          continue;

        int one_card =
            card_num * (first_deal + i) + (second_deal + j) + 1 + card_num;
        all_deal.push_back(one_card);
      }
    }
  }
  return all_deal;
}

vector<float> DCfrSolver::cfr(int player, shared_ptr<GameTreeNode> node,
                              const vector<float> &reach_probs, int iter,
                              uint64_t current_board, int deal) {
  switch (node->getType()) {
  case GameTreeNode::ACTION: {
    shared_ptr<ActionNode> action_node =
        std::dynamic_pointer_cast<ActionNode>(node);
    return actionUtility(player, action_node, reach_probs, iter, current_board,
                         deal);
  }
  case GameTreeNode::SHOWDOWN: {
    shared_ptr<ShowdownNode> showdown_node =
        std::dynamic_pointer_cast<ShowdownNode>(node);
    return showdownUtility(player, showdown_node, reach_probs, iter,
                           current_board, deal);
  }
  case GameTreeNode::TERMINAL: {
    shared_ptr<TerminalNode> terminal_node =
        std::dynamic_pointer_cast<TerminalNode>(node);
    return terminalUtility(player, terminal_node, reach_probs, iter,
                           current_board, deal);
  }
  case GameTreeNode::CHANCE: {
    shared_ptr<ChanceNode> chance_node =
        std::dynamic_pointer_cast<ChanceNode>(node);
    return chanceUtility(player, chance_node, reach_probs, iter, current_board,
                         deal);
  }
  default:
    throw runtime_error("node type unknown");
  }
}

vector<float> DCfrSolver::chanceUtility(int player, shared_ptr<ChanceNode> node,
                                        const vector<float> &reach_probs,
                                        int iter, uint64_t current_board,
                                        int deal) {
  vector<Card> &cards = this->deck.getCards();

  int card_num = node->getCards().size();
  if (card_num % 4 != 0)
    throw runtime_error("card num cannot round 4");
  int possible_deals =
      node->getCards().size() - Card::long2board(current_board).size() - 2;
  int oppo = 1 - player;

  vector<float> chance_utility = vector<float>(this->ranges[player].size());
  fill(chance_utility.begin(), chance_utility.end(), 0);

  int random_deal = 0;
  vector<vector<float>> results(node->getCards().size());

  vector<float> multiplier;
  if (iter <= this->warmup) {
    multiplier = vector<float>(card_num);
    fill(multiplier.begin(), multiplier.end(), 0);
    for (int card_base = 0; card_base < card_num / 4; card_base++) {
      int cardr = std::rand() % 4;
      int card_target = card_base * 4 + cardr;
      int multiplier_num = 0;
      for (int i = 0; i < 4; i++) {
        int i_card = card_base * 4 + i;
        if (i == cardr) {
          Card *one_card = const_cast<Card *>(&(node->getCards()[i_card]));
          uint64_t card_long = Card::boardInt2long(one_card->getCardInt());
          if (!Card::boardsHasIntercept(card_long, current_board)) {
            multiplier_num += 1;
          }
        } else {
          Card *one_card = const_cast<Card *>(&(node->getCards()[i_card]));
          uint64_t card_long = Card::boardInt2long(one_card->getCardInt());
          if (!Card::boardsHasIntercept(card_long, current_board)) {
            multiplier_num += 1;
          }
        }
      }
      multiplier[card_target] = multiplier_num;
    }
  }

  vector<int> valid_cards;
  valid_cards.reserve(node->getCards().size());

  for (int card = 0; card < node->getCards().size(); card++) {
    shared_ptr<GameTreeNode> one_child = node->getChildren();
    Card *one_card = const_cast<Card *>(&(node->getCards()[card]));
    uint64_t card_long = Card::boardInt2long(one_card->getCardInt());
    if (Card::boardsHasIntercept(card_long, current_board))
      continue;
    if (iter <= this->warmup && multiplier[card] == 0)
      continue;
    if (this->color_iso_offset[deal][one_card->getCardInt() % 4] < 0)
      continue;
    valid_cards.push_back(card);
  }

#pragma omp parallel for schedule(dynamic)
  for (int valid_ind = 0; valid_ind < valid_cards.size(); valid_ind++) {
    int card = valid_cards[valid_ind];
    shared_ptr<GameTreeNode> one_child = node->getChildren();
    Card *one_card = const_cast<Card *>(&(node->getCards()[card]));
    uint64_t card_long = Card::boardInt2long(one_card->getCardInt());

    uint64_t new_board_long = current_board | card_long;
    vector<PrivateCards> &playerPrivateCard = (this->ranges[player]);
    vector<PrivateCards> &oppoPrivateCards = (this->ranges[1 - player]);

    vector<float> new_reach_probs = vector<float>(oppoPrivateCards.size());

    int player_hand_len = this->ranges[oppo].size();
    for (int player_hand = 0; player_hand < player_hand_len; player_hand++) {
      PrivateCards &one_private = this->ranges[oppo][player_hand];
      uint64_t privateBoardLong = one_private.toBoardLong();
      if (Card::boardsHasIntercept(card_long, privateBoardLong)) {
        new_reach_probs[player_hand] = 0;
        continue;
      }
      new_reach_probs[player_hand] = reach_probs[player_hand] / possible_deals;
    }
    int new_deal;
    if (deal == 0) {
      new_deal = card + 1;
    } else if (deal > 0 && deal <= card_num) {
      int origin_deal = deal - 1;
      new_deal = card_num * origin_deal + card;
      new_deal += (1 + card_num);
    } else {
      throw runtime_error(fmt::format("deal out of range : {} ", deal));
    }
    if (this->distributing_task && node->getRound() == this->split_round) {
      results[one_card->getNumberInDeckInt()] =
          vector<float>(this->ranges[player].size());
    } else {
      vector<float> child_utility = this->cfr(
          player, one_child, new_reach_probs, iter, new_board_long, new_deal);
      results[one_card->getNumberInDeckInt()] = child_utility;
    }
  }

  for (int card = 0; card < node->getCards().size(); card++) {
    Card *one_card = const_cast<Card *>(&(node->getCards()[card]));
    vector<float> child_utility;
    int offset = this->color_iso_offset[deal][one_card->getCardInt() % 4];
    if (offset < 0) {
      int rank1 = one_card->getCardInt() % 4;
      int rank2 = rank1 + offset;
      child_utility = results[one_card->getNumberInDeckInt() + offset];
      exchange_color(child_utility, this->pcm.getPreflopCards(player), rank1,
                     rank2);
    } else {
      child_utility = results[one_card->getNumberInDeckInt()];
    }
    if (child_utility.empty())
      continue;

    if (iter > this->warmup) {
      for (int i = 0; i < child_utility.size(); i++)
        chance_utility[i] += child_utility[i];
    } else {
      for (int i = 0; i < child_utility.size(); i++)
        chance_utility[i] += child_utility[i] * multiplier[card];
    }
  }

  return chance_utility;
}

vector<float> DCfrSolver::actionUtility(int player, shared_ptr<ActionNode> node,
                                        const vector<float> &reach_probs,
                                        int iter, uint64_t current_board,
                                        int deal) {
  int oppo = 1 - player;
  const vector<PrivateCards> &node_player_private_cards =
      this->ranges[node->getPlayer()];

  vector<float> payoffs(this->ranges[player].size(), 0.0f);
  vector<shared_ptr<GameTreeNode>> &children = node->getChildrens();
  vector<GameActions> &actions = node->getActions();

  shared_ptr<DiscountedCfr> trainable = node->getTrainable(deal);

  const vector<float> current_strategy = trainable->getcurrentStrategy();
  vector<float> regrets(actions.size() * node_player_private_cards.size());
  vector<vector<float>> all_action_utility(actions.size());
  vector<vector<float>> results(actions.size());
  {
    {
      for (int action_id = 0; action_id < actions.size(); ++action_id) {
        {
          if (node->getPlayer() != player) {
            vector<float> new_reach_prob(reach_probs.size());
            for (size_t hand_id = 0; hand_id < new_reach_prob.size();
                 ++hand_id) {
              float strategy_prob =
                  current_strategy[hand_id +
                                   action_id *
                                       node_player_private_cards.size()];
              new_reach_prob[hand_id] = reach_probs[hand_id] * strategy_prob;
            }
#pragma omp task shared(results, action_id)
            results[action_id] =
                this->cfr(player, children[action_id], new_reach_prob, iter,
                          current_board, deal);
          } else {
#pragma omp task shared(results, action_id)
            results[action_id] =
                this->cfr(player, children[action_id], reach_probs, iter,
                          current_board, deal);
          }
        } // task
      }   // for
    }     // single
  }       // parallel

/* ---------- aggregate utilities & compute regrets ---------- */
#pragma omp taskwait
  for (int action_id = 0; action_id < actions.size(); ++action_id) {
    vector<float> &action_utilities = results[action_id];
    if (action_utilities.empty())
      continue;

    all_action_utility[action_id] = action_utilities;

    for (int hand_id = 0; hand_id < action_utilities.size(); ++hand_id) {
      if (player == node->getPlayer()) {
        float strategy_prob =
            current_strategy[hand_id +
                             action_id * node_player_private_cards.size()];
        payoffs[hand_id] += strategy_prob * action_utilities[hand_id];
      } else {
        payoffs[hand_id] += action_utilities[hand_id];
      }
    }
  }

  /* ---------- store normalised EV vector ---------- */
  if (player == node->getPlayer()) {
    float denom = std::accumulate(reach_probs.begin(), reach_probs.end(), 0.0f);

    if (denom > 0.0f) {
      vector<float> normalised(payoffs.size());
      std::transform(payoffs.begin(), payoffs.end(), normalised.begin(),
                     [denom](float x) { return x / denom; });
      trainable->setLastEV(normalised);
    } else {
      trainable->setLastEV(payoffs);
    }

    /* ---------- regret update ---------- */
    for (int hand_id = 0; hand_id < node_player_private_cards.size();
         ++hand_id) {
      for (int action_id = 0; action_id < actions.size(); ++action_id) {
        regrets[action_id * node_player_private_cards.size() + hand_id] =
            all_action_utility[action_id][hand_id] - payoffs[hand_id];
      }
    }

    if (!this->distributing_task) {
      if (iter > this->warmup) {
        trainable->updateRegrets(regrets, iter + 1, reach_probs);
      } else {
        vector<int> deals = this->getAllAbstractionDeal(deal);
        shared_ptr<DiscountedCfr> standard_trainable = nullptr;
        for (int one_deal : deals) {
          shared_ptr<DiscountedCfr> one_trainable =
              node->getTrainable(one_deal);
          if (standard_trainable == nullptr) {
            one_trainable->updateRegrets(regrets, iter + 1, reach_probs);
            standard_trainable = one_trainable;
          } else {
            one_trainable->copyStrategy(standard_trainable);
          }
        }
      }
    }
  }

  return payoffs;
}

vector<float> DCfrSolver::showdownUtility(int player,
                                          shared_ptr<ShowdownNode> node,
                                          const vector<float> &reach_probs,
                                          int iter, uint64_t current_board,
                                          int deal) {
  int oppo = 1 - player;
  float win_payoff =
      node->get_payoffs(ShowdownNode::ShowDownResult::NOTTIE, player, player);
  float lose_payoff =
      node->get_payoffs(ShowdownNode::ShowDownResult::NOTTIE, oppo, player);
  const vector<PrivateCards> &player_private_cards = this->ranges[player];
  const vector<PrivateCards> &oppo_private_cards = this->ranges[oppo];

  const vector<RiverCombs> &player_combs =
      this->rrm.getRiverCombos(player, player_private_cards, current_board);
  const vector<RiverCombs> &oppo_combs =
      this->rrm.getRiverCombos(oppo, oppo_private_cards, current_board);

  vector<float> payoffs = vector<float>(player_private_cards.size());

  float winsum = 0;
  vector<float> card_winsum = vector<float>(52);
  fill(card_winsum.begin(), card_winsum.end(), 0);

  int j = 0;
  for (int i = 0; i < player_combs.size(); i++) {
    const RiverCombs &one_player_comb = player_combs[i];
    while (j < oppo_combs.size() && one_player_comb.rank < oppo_combs[j].rank) {
      const RiverCombs &one_oppo_comb = oppo_combs[j];
      winsum += reach_probs[one_oppo_comb.reach_prob_index];
      card_winsum[one_oppo_comb.private_cards.card1] +=
          reach_probs[one_oppo_comb.reach_prob_index];
      card_winsum[one_oppo_comb.private_cards.card2] +=
          reach_probs[one_oppo_comb.reach_prob_index];
      j++;
    }
    payoffs[one_player_comb.reach_prob_index] =
        (winsum - card_winsum[one_player_comb.private_cards.card1] -
         card_winsum[one_player_comb.private_cards.card2]) *
        win_payoff;
  }

  float losssum = 0;
  vector<float> &card_losssum = card_winsum;
  fill(card_losssum.begin(), card_losssum.end(), 0);

  j = oppo_combs.size() - 1;
  for (int i = player_combs.size() - 1; i >= 0; i--) {
    const RiverCombs &one_player_comb = player_combs[i];
    while (j >= 0 && one_player_comb.rank > oppo_combs[j].rank) {
      const RiverCombs &one_oppo_comb = oppo_combs[j];
      losssum += reach_probs[one_oppo_comb.reach_prob_index];
      card_losssum[one_oppo_comb.private_cards.card1] +=
          reach_probs[one_oppo_comb.reach_prob_index];
      card_losssum[one_oppo_comb.private_cards.card2] +=
          reach_probs[one_oppo_comb.reach_prob_index];
      j--;
    }
    payoffs[one_player_comb.reach_prob_index] +=
        (losssum - card_losssum[one_player_comb.private_cards.card1] -
         card_losssum[one_player_comb.private_cards.card2]) *
        lose_payoff;
  }
  return payoffs;
}

vector<float> DCfrSolver::terminalUtility(int player,
                                          shared_ptr<TerminalNode> node,
                                          const vector<float> &reach_prob,
                                          int iter, uint64_t current_board,
                                          int deal) {
  float player_payoff = node->get_payoffs()[player];

  int oppo = 1 - player;
  const vector<PrivateCards> &player_hand = playerHands(player);
  const vector<PrivateCards> &oppo_hand = playerHands(oppo);

  vector<float> payoffs = vector<float>(this->playerHands(player).size());

  float oppo_sum = 0;
  vector<float> oppo_card_sum = vector<float>(52);
  fill(oppo_card_sum.begin(), oppo_card_sum.end(), 0);

  for (int i = 0; i < oppo_hand.size(); i++) {
    oppo_card_sum[oppo_hand[i].card1] += reach_prob[i];
    oppo_card_sum[oppo_hand[i].card2] += reach_prob[i];
    oppo_sum += reach_prob[i];
  }

  for (int i = 0; i < player_hand.size(); i++) {
    const PrivateCards &one_player_hand = player_hand[i];
    if (Card::boardsHasIntercept(
            current_board, Card::boardInts2long(one_player_hand.get_hands()))) {
      continue;
    }
    int oppo_same_card_ind = this->pcm.indPlayer2Player(player, oppo, i);
    float plus_reach_prob;
    if (oppo_same_card_ind == -1) {
      plus_reach_prob = 0;
    } else {
      plus_reach_prob = reach_prob[oppo_same_card_ind];
    }
    payoffs[i] = player_payoff *
                 (oppo_sum - oppo_card_sum[one_player_hand.card1] -
                  oppo_card_sum[one_player_hand.card2] + plus_reach_prob);
  }

  return payoffs;
}

void DCfrSolver::findGameSpecificIsomorphisms() {
  // hand isomorphisms
  vector<Card> board_cards = Card::long2boardCards(this->initial_board_long);
  for (int i = 0; i <= 1; i++) {
    vector<PrivateCards> &range = i == 0 ? this->range1 : this->range2;
    for (int i_range = 0; i_range < range.size(); i_range++) {
      PrivateCards one_range = range[i_range];
      uint32_t range_hash[4]; // four colors, hash of the isomorphisms range +
                              // hand combos
      for (int i = 0; i < 4; i++)
        range_hash[i] = 0;
      for (int color = 0; color < 4; color++) {
        for (Card one_card : board_cards) {
          if (one_card.getCardInt() % 4 == color) {
            range_hash[color] =
                range_hash[color] | (1 << (one_card.getCardInt() / 4));
          }
        }
      }
      for (int color = 0; color < 4; color++) {
        for (int one_card_int : {one_range.card1, one_range.card2}) {
          if (one_card_int % 4 == color) {
            range_hash[color] =
                range_hash[color] | (1 << (one_card_int / 4 + 16));
          }
        }
      }
    }
  }

  // chance node isomorphisms
  uint16_t color_hash[4];
  for (int i = 0; i < 4; i++)
    color_hash[i] = 0;
  for (Card one_card : board_cards) {
    int rankind = one_card.getCardInt() % 4;
    int suitind = one_card.getCardInt() / 4;
    color_hash[rankind] = color_hash[rankind] | (1 << suitind);
  }
  for (int i = 0; i < 4; i++) {
    this->color_iso_offset[0][i] = 0;
    for (int j = 0; j < i; j++) {
      if (color_hash[i] == color_hash[j]) {
        this->color_iso_offset[0][i] = j - i;
        continue;
      }
    }
  }
  for (int deal = 0; deal < this->deck.getCards().size(); deal++) {
    uint16_t color_hash[4];
    for (int i = 0; i < 4; i++)
      color_hash[i] = 0;
    // chance node isomorphisms
    for (Card one_card : board_cards) {
      int rankind = one_card.getCardInt() % 4;
      int suitind = one_card.getCardInt() / 4;
      color_hash[rankind] = color_hash[rankind] | (1 << suitind);
    }
    Card one_card = this->deck.getCards()[deal];
    int rankind = one_card.getCardInt() % 4;
    int suitind = one_card.getCardInt() / 4;
    color_hash[rankind] = color_hash[rankind] | (1 << suitind);
    for (int i = 0; i < 4; i++) {
      this->color_iso_offset[deal + 1][i] = 0;
      for (int j = 0; j < i; j++) {
        if (color_hash[i] == color_hash[j]) {
          this->color_iso_offset[deal + 1][i] = j - i;
          continue;
        }
      }
    }
  }
}

void DCfrSolver::train() {

  vector<vector<PrivateCards>> player_privates(this->player_number);
  player_privates[0] = pcm.getPreflopCards(0);
  player_privates[1] = pcm.getPreflopCards(1);
  if (this->use_isomorphism) {
    this->findGameSpecificIsomorphisms();
  }

  BestResponse br =
      BestResponse(player_privates, this->player_number, this->pcm, this->rrm,
                   this->deck, this->debug, this->color_iso_offset,
                   this->split_round, this->num_threads);

  br.printExploitability(tree->getRoot(), 0, tree->getRoot()->getPot(),
                         initial_board_long);

  vector<vector<float>> reach_probs = this->getReachProbs();
  ofstream fileWriter;
  if (!this->logfile.empty())
    fileWriter.open(this->logfile);

  uint64_t begintime = timeSinceEpochMillisec();
  uint64_t endtime = timeSinceEpochMillisec();

  for (int i = 0; i < this->iteration_number; i++) {
    for (int player_id = 0; player_id < this->player_number; player_id++) {
      this->round_deal = vector<int>{-1, -1, -1, -1};
#pragma omp parallel
      {
#pragma omp single nowait
        {
          cfr(player_id, this->tree->getRoot(), reach_probs[1 - player_id], i,
              this->initial_board_long, 0);
        } // single
      }   // parallel
    }
    if (i % this->print_interval == 0 && i != 0 && i >= this->warmup) {
      endtime = timeSinceEpochMillisec();
      long time_ms = endtime - begintime;
      cout << ("-------------------") << endl;
      float exploitability =
          br.printExploitability(tree->getRoot(), i + 1,
                                 tree->getRoot()->getPot(), initial_board_long);
      cout << "time used: " << float(time_ms) / 1000 << endl;
      if (!this->logfile.empty()) {
        json jo;
        jo["iteration"] = i;
        jo["exploitability"] = exploitability;
        jo["time_ms"] = time_ms;
        fileWriter << jo << endl;
      }
      if (exploitability <= this->accuracy) {
        break;
      }
    }
  }
  if (!this->logfile.empty()) {
    fileWriter.flush();
    fileWriter.close();
  }
}

void DCfrSolver::exchangeRange(json &strategy, int rank1, int rank2,
                               shared_ptr<ActionNode> one_node) {
  if (rank1 == rank2)
    return;
  int player = one_node->getPlayer();
  vector<string> range_strs;
  vector<vector<float>> strategies;

  for (int i = 0; i < this->ranges[player].size(); i++) {
    string one_range_str = this->ranges[player][i].toString();
    if (!strategy.contains(one_range_str)) {
      for (auto one_key : strategy.items()) {
        cout << one_key.key() << endl;
      }
      cout << "strategy: " << strategy << endl;
      throw runtime_error(
          fmt::format("{} not exist in strategy", one_range_str));
    }
    vector<float> one_strategy = strategy[one_range_str];
    range_strs.push_back(one_range_str);
    strategies.push_back(one_strategy);
  }
  exchange_color(strategies, this->ranges[player], rank1, rank2);

  for (int i = 0; i < this->ranges[player].size(); i++) {
    string one_range_str = this->ranges[player][i].toString();
    vector<float> one_strategy = strategies[i];
    strategy[one_range_str] = one_strategy;
  }
}

void DCfrSolver::reConvertJson(
    const std::shared_ptr<GameTreeNode> &node, json &strategy, std::string key,
    int depth, int max_depth, std::vector<std::string> prefix, int deal,
    std::vector<std::vector<int>> exchange_color_list) {
  if (depth >= max_depth)
    return;

  json node_obj;

  if (node->getType() == GameTreeNode::GameTreeNodeType::ACTION) {
    auto one_node = std::dynamic_pointer_cast<ActionNode>(node);

    std::vector<std::string> actions;
    for (const auto &act : one_node->getActions()) {
      std::string actStr = const_cast<GameActions &>(act).toString();
      actions.push_back(cleanActionString(actStr));
    }
    node_obj["a"] = actions;
    node_obj["p"] = one_node->getPlayer();

    std::vector<json> temp_children(one_node->getActions().size());

#pragma omp parallel
#pragma omp single nowait
    {
      for (int i = 0; i < one_node->getActions().size(); ++i) {
#pragma omp task firstprivate(i) shared(temp_children)
        {
          auto one_child = one_node->getChildrens()[i];
          json child_node;
          std::vector<std::string> new_prefix = prefix;
          new_prefix.push_back(one_node->getActions()[i].toString());
          this->reConvertJson(one_child, child_node, "", depth, max_depth,
                              new_prefix, deal, exchange_color_list);
          temp_children[i] = std::move(child_node);
        }
      }
    }
    json children_array = json::array();
    for (auto &&child : temp_children) {
      children_array.push_back(std::move(child));
    }

    if (!children_array.empty())
      node_obj["c"] = children_array;

    auto trainable = one_node->getTrainable(deal, false);
    if (trainable != nullptr) {
      json strategy_dump = trainable->dump_strategy(false);
      node_obj["s"] = strategy_dump;
      if (node_obj["s"].contains("s")) {
        for (const auto &one_exchange : exchange_color_list) {
          int rank1 = one_exchange[0];
          int rank2 = one_exchange[1];
          this->exchangeRange(node_obj["s"]["s"], rank1, rank2, one_node);
        }
      } else {
        for (const auto &one_exchange : exchange_color_list) {
          int rank1 = one_exchange[0];
          int rank2 = one_exchange[1];
          this->exchangeRange(node_obj["s"], rank1, rank2, one_node);
        }
      }
    }
    node_obj["t"] = "a";
  } else if (node->getType() == GameTreeNode::GameTreeNodeType::SHOWDOWN) {
    node_obj["t"] = "sd";
  } else if (node->getType() == GameTreeNode::GameTreeNodeType::TERMINAL) {
    node_obj["t"] = "term";
  } else if (node->getType() == GameTreeNode::GameTreeNodeType::CHANCE) {
    auto chanceNode = std::dynamic_pointer_cast<ChanceNode>(node);
    const std::vector<Card> &cards = chanceNode->getCards();
    json d_obj = json::object();
    for (int i = 0; i < cards.size(); i++) {
      std::vector<std::vector<int>> new_exchange_color_list(
          exchange_color_list);
      Card &one_card = const_cast<Card &>(cards[i]);
      std::vector<std::string> new_prefix = prefix;
      new_prefix.push_back("C:" + one_card.toString());
      int card = i;
      int offset = this->color_iso_offset[deal][one_card.getCardInt() % 4];
      if (offset < 0) {
        for (int x = 0; x < cards.size(); x++) {
          if (Card::card2int(cards[x]) ==
              (Card::card2int(cards[card]) + offset)) {
            card = x;
            break;
          }
        }
        if (card == i) {
          throw std::runtime_error("isomorphism not found while dump strategy");
        }
        std::vector<int> one_exchange{one_card.getCardInt() % 4,
                                      one_card.getCardInt() % 4 + offset};
        new_exchange_color_list.push_back(one_exchange);
      }
      int card_num = this->deck.getCards().size();
      int new_deal;
      if (deal == 0) {
        new_deal = card + 1;
      } else if (deal > 0 && deal <= card_num) {
        int origin_deal = deal - 1;
        new_deal = card_num * origin_deal + card;
        new_deal += (1 + card_num);
      } else {
        throw std::runtime_error(fmt::format("deal out of range : {} ", deal));
      }
      if (exchange_color_list.size() > 1) {
        throw std::runtime_error(
            "exchange color list shouldn't exceed size 1 here");
      }
      std::string one_card_str = one_card.toString();
      if (exchange_color_list.size() == 1) {
        int rank1 = exchange_color_list[0][0];
        int rank2 = exchange_color_list[0][1];
        if (one_card.getCardInt() % 4 == rank1)
          one_card_str =
              Card::intCard2Str(one_card.getCardInt() - rank1 + rank2);
        else if (one_card.getCardInt() % 4 == rank2)
          one_card_str =
              Card::intCard2Str(one_card.getCardInt() - rank2 + rank1);
      }
      json child_node;
      this->reConvertJson(chanceNode->getChildren(), child_node, "", depth + 1,
                          max_depth, new_prefix, new_deal,
                          new_exchange_color_list);
      d_obj[one_card_str] = child_node;
    }
    node_obj["d"] = d_obj;
    node_obj["dn"] = d_obj.size();
    node_obj["t"] = "ch";
  } else {
    throw std::runtime_error("node type unknown!!");
  }

  if (!key.empty())
    strategy[key] = node_obj;
  else
    strategy = node_obj;
}

json DCfrSolver::dumps(bool with_status, int depth) {
  if (with_status == true) {
    throw std::runtime_error("");
  }
  json retjson;
  this->reConvertJson(this->tree->getRoot(), retjson, "", 0, depth,
                      std::vector<std::string>({"begin"}), 0,
                      std::vector<std::vector<int>>());
  return std::move(retjson);
}

BestResponse::BestResponse(vector<vector<PrivateCards>> &private_combos,
                           int player_number, PrivateCardsManager &pcm,
                           RiverRangeManager &rrm, Deck &deck, bool debug,
                           int color_iso_offset[][4],
                           GameTreeNode::GameRound split_round, int nthreads)
    : rrm(rrm), pcm(pcm), private_combos(private_combos), deck(deck) {
  this->player_number = player_number;
  this->debug = debug;

  player_hands = vector<int>(player_number);
  for (int i = 0; i < player_number; i++) {
    player_hands[i] = private_combos[i].size();
  }
  this->nthreads = nthreads;
  for (int i = 0; i < 52 * 52 * 2; i++) {
    for (int j = 0; j < 4; j++) {
      this->color_iso_offset[i][j] = color_iso_offset[i][j];
    }
  }
  this->split_round = split_round;
  omp_set_num_threads(this->nthreads);
}

float BestResponse::printExploitability(shared_ptr<GameTreeNode> root,
                                        int iterationCount, float initial_pot,
                                        uint64_t initialBoard) {
  if (this->reach_probs.empty())
    this->reach_probs = vector<vector<float>>(this->player_number);

  cout << (fmt::format("Iter: {}", iterationCount)) << endl;
  float exploitible = 0;
  for (int player_id = 0; player_id < this->player_number; player_id++) {
    if (reach_probs[player_id].empty()) {
      reach_probs[player_id] = vector<float>(private_combos[player_id].size());
    }
    for (int hc = 0; hc < private_combos[player_id].size(); hc++)
      reach_probs[player_id][hc] = private_combos[player_id][hc].weight;
  }

  for (int player_id = 0; player_id < this->player_number; player_id++) {
    float player_exploitability =
        getBestReponseEv(root, player_id, reach_probs, initialBoard, 0);
    exploitible += player_exploitability;
    cout << (fmt::format("player {} exploitability {}", player_id,
                         player_exploitability))
         << endl;
  }
  float total_exploitability =
      exploitible / this->player_number / initial_pot * 100;
  cout << (fmt::format("Total exploitability {} precent", total_exploitability))
       << endl;
  return total_exploitability;
}

float BestResponse::getBestReponseEv(shared_ptr<GameTreeNode> node, int player,
                                     vector<vector<float>> reach_probs,
                                     uint64_t initialBoard, int deal) {
  float ev = 0;
  const vector<float> &private_cards_evs =
      bestResponse(node, player, reach_probs, initialBoard, deal);
  vector<PrivateCards> &player_combo = this->private_combos[player];
  vector<PrivateCards> &oppo_combo = this->private_combos[1 - player];

  for (int player_hand = 0; player_hand < player_combo.size(); player_hand++) {
    float one_payoff = private_cards_evs[player_hand];
    PrivateCards &one_player_hand = (player_combo)[player_hand];
    uint64_t private_long = one_player_hand.toBoardLong();
    if (Card::boardsHasIntercept(private_long, initialBoard)) {
      continue;
    }
    float oppo_sum = 0;

    for (int oppo_hand = 0; oppo_hand < oppo_combo.size(); oppo_hand++) {
      PrivateCards &one_oppo_hand = (oppo_combo)[oppo_hand];
      uint64_t private_long_oppo = one_oppo_hand.toBoardLong();
      if (Card::boardsHasIntercept(private_long, private_long_oppo) ||
          Card::boardsHasIntercept(private_long_oppo, initialBoard)) {
        continue;
      }
      oppo_sum += one_oppo_hand.weight;
    }
    ev += one_payoff * one_player_hand.relative_prob / oppo_sum;
  }

  return ev;
}

vector<float>
BestResponse::bestResponse(shared_ptr<GameTreeNode> node, int player,
                           const vector<vector<float>> &reach_probs,
                           uint64_t board, int deal) {
  if (node->getType() == GameTreeNode::ACTION) {
    shared_ptr<ActionNode> action_node =
        std::dynamic_pointer_cast<ActionNode>(node);
    return actionBestResponse(action_node, player, reach_probs, board, deal);
  } else if (node->getType() == GameTreeNode::SHOWDOWN) {
    shared_ptr<ShowdownNode> showdown_node =
        std::dynamic_pointer_cast<ShowdownNode>(node);
    return showdownBestResponse(showdown_node, player, reach_probs, board,
                                deal);
  } else if (node->getType() == GameTreeNode::TERMINAL) {
    shared_ptr<TerminalNode> terminal_node =
        std::dynamic_pointer_cast<TerminalNode>(node);
    return terminalBestReponse(terminal_node, player, reach_probs, board, deal);
  } else if (node->getType() == GameTreeNode::CHANCE) {
    shared_ptr<ChanceNode> chance_node =
        std::dynamic_pointer_cast<ChanceNode>(node);
    return chanceBestReponse(chance_node, player, reach_probs, board, deal);
  } else
    throw runtime_error("Node type not understood ");
}

vector<float>
BestResponse::chanceBestReponse(shared_ptr<ChanceNode> node, int player,
                                const vector<vector<float>> &reach_probs,
                                uint64_t current_board, int deal) {
  vector<Card> &cards = this->deck.getCards();

  int card_num = node->getCards().size();
  int possible_deals =
      node->getCards().size() - Card::long2board(current_board).size() - 2;

  vector<float> chance_utility = vector<float>(reach_probs[player].size());
  fill(chance_utility.begin(), chance_utility.end(), 0);

  vector<vector<vector<float>>> best_respond_arr_new_reach_probs =
      vector<vector<vector<float>>>(node->getCards().size());

  vector<vector<float>> results(node->getCards().size());

#pragma omp parallel for
  for (int card = 0; card < node->getCards().size(); card++) {
    shared_ptr<GameTreeNode> one_child = node->getChildren();
    Card one_card = node->getCards()[card];
    uint64_t card_long = Card::boardInt2long(one_card.getCardInt());

    if (Card::boardsHasIntercept(card_long, current_board))
      continue;
    if (this->color_iso_offset[deal][one_card.getCardInt() % 4] < 0)
      continue;

    const vector<PrivateCards> &playerPrivateCard =
        this->pcm.getPreflopCards(player);
    const vector<PrivateCards> &oppoPrivateCards =
        this->pcm.getPreflopCards(1 - player);

    if (best_respond_arr_new_reach_probs[card].empty()) {
      best_respond_arr_new_reach_probs[card] = vector<vector<float>>(2);
    }
    vector<vector<float>> new_reach_probs =
        best_respond_arr_new_reach_probs[card];
    if (new_reach_probs[player].empty()) {
      new_reach_probs[player] = vector<float>(playerPrivateCard.size());
      new_reach_probs[1 - player] = vector<float>(oppoPrivateCards.size());
    }

    for (int one_player = 0; one_player < 2; one_player++) {
      int player_hand_len = this->pcm.getPreflopCards(one_player).size();
      for (int player_hand = 0; player_hand < player_hand_len; player_hand++) {
        uint64_t privateBoardLong =
            this->pcm.getPreflopCards(one_player)[player_hand].toBoardLong();
        if (Card::boardsHasIntercept(card_long, privateBoardLong)) {
          new_reach_probs[one_player][player_hand] = 0;
          continue;
        }
        new_reach_probs[one_player][player_hand] =
            reach_probs[one_player][player_hand] / possible_deals;
      }
    }

    uint64_t new_board_long = current_board | card_long;

    int new_deal;
    if (deal == 0) {
      new_deal = card + 1;
    } else if (deal > 0 && deal <= card_num) {
      int origin_deal = deal - 1;
      new_deal = card_num * origin_deal + card;
      new_deal += (1 + card_num);
    } else {
      throw runtime_error(fmt::format("deal out of range : {} ", deal));
    }
    vector<float> child_utility = this->bestResponse(
        one_child, player, new_reach_probs, new_board_long, new_deal);
    results[one_card.getNumberInDeckInt()] = child_utility;
  }

  for (int card = 0; card < node->getCards().size(); card++) {
    Card *one_card = const_cast<Card *>(&(node->getCards()[card]));
    vector<float> child_utility;
    int offset = this->color_iso_offset[deal][one_card->getCardInt() % 4];
    if (offset < 0) {
      int rank1 = one_card->getCardInt() % 4;
      int rank2 = rank1 + offset;
      child_utility = results[one_card->getNumberInDeckInt() + offset];
      exchange_color(child_utility, private_combos[player], rank1, rank2);
    } else {
      child_utility = results[one_card->getNumberInDeckInt()];
    }

    if (child_utility.empty())
      continue;
    for (int i = 0; i < child_utility.size(); i++)
      chance_utility[i] += (child_utility)[i];
  }

  return chance_utility;
}

vector<float>
BestResponse::actionBestResponse(shared_ptr<ActionNode> node, int player,
                                 const vector<vector<float>> &reach_probs,
                                 uint64_t board, int deal) {
  if (player == node->getPlayer()) {
    vector<float> my_exploitability = vector<float>(reach_probs[player].size());

    bool first_action_flag = true;
    for (shared_ptr<GameTreeNode> one_node : node->getChildrens()) {
      const vector<float> &node_ev =
          this->bestResponse(one_node, player, reach_probs, board, deal);
      if (first_action_flag) {
        my_exploitability.assign(node_ev.begin(), node_ev.end());
        first_action_flag = false;
      } else {
        for (int i = 0; i < node_ev.size(); i++) {
          my_exploitability[i] = max(my_exploitability[i], node_ev[i]);
        }
      }
    }
    if (this->debug) {
      cout << ("[action]") << endl;
      node->printHistory();
    }
    return my_exploitability;
  } else {
    vector<float> total_payoffs = vector<float>(player_hands[player]);
    fill(total_payoffs.begin(), total_payoffs.end(), 0);
    shared_ptr<DiscountedCfr> trainable = node->getTrainable(deal);
    const vector<float> &node_strategy = trainable->getAverageStrategy();
    vector<vector<vector<float>>> best_respond_arr_new_reach_probs =
        vector<vector<vector<float>>>(node->getChildrens().size());
    for (int action_ind = 0; action_ind < node->getChildrens().size();
         action_ind++) {
      if (best_respond_arr_new_reach_probs[action_ind].empty()) {
        best_respond_arr_new_reach_probs[action_ind] =
            vector<vector<float>>(this->player_number);
      }
      vector<vector<float>> &next_reach_probs =
          best_respond_arr_new_reach_probs[action_ind];
      if (next_reach_probs[player].empty()) {
        next_reach_probs[player] = vector<float>(reach_probs[player].size());
        next_reach_probs[1 - player] =
            vector<float>(reach_probs[1 - player].size());
      }
      for (int i = 0; i < this->player_number; i++) {
        if (i == node->getPlayer()) {
          int private_combo_numbers = reach_probs[i].size();
          for (int j = 0; j < private_combo_numbers; j++) {
            next_reach_probs[i][j] =
                reach_probs[node->getPlayer()][j] *
                node_strategy[action_ind * private_combo_numbers + j];
          }
        } else {
          next_reach_probs[i].assign(reach_probs[i].begin(),
                                     reach_probs[i].end());
        }
      }

      shared_ptr<GameTreeNode> one_child = node->getChildrens()[action_ind];

      const vector<float> &action_payoffs =
          this->bestResponse(one_child, player, next_reach_probs, board, deal);

      for (int i = 0; i < total_payoffs.size(); i++) {
        total_payoffs[i] += action_payoffs[i];
      }
    }
    if (this->debug) {
      cout << ("[action]") << endl;
      node->printHistory();
    }
    return total_payoffs;
  }
}

vector<float>
BestResponse::terminalBestReponse(shared_ptr<TerminalNode> node, int player,
                                  const vector<vector<float>> &reach_probs,
                                  uint64_t board, int deal) {
  uint64_t board_long = board;
  int oppo = 1 - player;
  const vector<RiverCombs> &player_combs = this->rrm.getRiverCombos(
      player, this->pcm.getPreflopCards(player), board);
  const vector<RiverCombs> &oppo_combs = this->rrm.getRiverCombos(
      1 - player, this->pcm.getPreflopCards(1 - player), board);

  float player_payoff = node->get_payoffs()[player];

  vector<float> payoffs = vector<float>(this->player_hands[player]);

  vector<float> oppo_card_sum(52);

  float oppo_prob_sum = 0;

  const vector<float> &oppo_reach_prob = reach_probs[1 - player];
  for (int oppo_hand = 0; oppo_hand < oppo_combs.size(); oppo_hand++) {
    const RiverCombs &one_hc = oppo_combs[oppo_hand];
    uint64_t one_hc_long =
        Card::boardInts2long(one_hc.private_cards.get_hands());

    if (Card::boardsHasIntercept(one_hc_long, board_long)) {
      continue;
    }

    oppo_prob_sum += oppo_reach_prob[one_hc.reach_prob_index];
    oppo_card_sum[one_hc.private_cards.card1] +=
        oppo_reach_prob[one_hc.reach_prob_index];
    oppo_card_sum[one_hc.private_cards.card2] +=
        oppo_reach_prob[one_hc.reach_prob_index];
  }

  for (int player_hand = 0; player_hand < player_combs.size(); player_hand++) {
    const RiverCombs &player_hc = player_combs[player_hand];
    uint64_t player_hc_long =
        Card::boardInts2long(player_hc.private_cards.get_hands());
    if (Card::boardsHasIntercept(player_hc_long, board_long)) {
      payoffs[player_hand] = 0;
    } else {
      int oppo_hand =
          this->pcm.indPlayer2Player(player, oppo, player_hc.reach_prob_index);
      float add_reach_prob;
      if (oppo_hand == -1) {
        add_reach_prob = 0;
      } else {
        add_reach_prob = oppo_reach_prob[oppo_hand];
      }
      payoffs[player_hc.reach_prob_index] =
          (oppo_prob_sum - oppo_card_sum[player_hc.private_cards.card1] -
           oppo_card_sum[player_hc.private_cards.card2] + add_reach_prob) *
          player_payoff;
    }
  }

  if (this->debug) {
    cout << ("[terminal]") << endl;
    node->printHistory();
  }
  return payoffs;
}

vector<float>
BestResponse::showdownBestResponse(shared_ptr<ShowdownNode> node, int player,
                                   const vector<vector<float>> &reach_probs,
                                   uint64_t board, int deal) {

  int oppo = 1 - player;
  const vector<RiverCombs> &player_combs = this->rrm.getRiverCombos(
      player, this->pcm.getPreflopCards(player), board);
  const vector<RiverCombs> &oppo_combs = this->rrm.getRiverCombos(
      1 - player, this->pcm.getPreflopCards(1 - player), board);

  float win_payoff =
      node->get_payoffs(ShowdownNode::ShowDownResult::NOTTIE, player)[player];
  float lose_payoff = node->get_payoffs(ShowdownNode::ShowDownResult::NOTTIE,
                                        1 - player)[player];

  vector<float> payoffs = vector<float>(player_hands[player]);
  float winsum = 0;
  vector<float> card_winsum(52);
  for (int i = 0; i < card_winsum.size(); i++)
    card_winsum[i] = 0;

  int j = 0;

  for (int i = 0; i < player_combs.size(); i++) {
    const RiverCombs &one_player_comb = player_combs[i];
    while (j < oppo_combs.size() && one_player_comb.rank < oppo_combs[j].rank) {
      const RiverCombs &one_oppo_comb = oppo_combs[j];
      winsum += reach_probs[oppo][one_oppo_comb.reach_prob_index];

      card_winsum[one_oppo_comb.private_cards.card1] +=
          reach_probs[oppo][one_oppo_comb.reach_prob_index];
      card_winsum[one_oppo_comb.private_cards.card2] +=
          reach_probs[oppo][one_oppo_comb.reach_prob_index];
      j++;
    }
    payoffs[one_player_comb.reach_prob_index] =
        (winsum - card_winsum[one_player_comb.private_cards.card1] -
         card_winsum[one_player_comb.private_cards.card2]) *
        win_payoff;
  }

  float losssum = 0;
  vector<float> card_losssum(52);

  j = oppo_combs.size() - 1;
  for (int i = player_combs.size() - 1; i >= 0; i--) {
    const RiverCombs &one_player_comb = player_combs[i];
    while (j >= 0 && one_player_comb.rank > oppo_combs[j].rank) {
      const RiverCombs &one_oppo_comb = oppo_combs[j];
      losssum += reach_probs[oppo][one_oppo_comb.reach_prob_index];

      card_losssum[one_oppo_comb.private_cards.card1] +=
          reach_probs[oppo][one_oppo_comb.reach_prob_index];
      card_losssum[one_oppo_comb.private_cards.card2] +=
          reach_probs[oppo][one_oppo_comb.reach_prob_index];
      j--;
    }
    payoffs[one_player_comb.reach_prob_index] +=
        (losssum - card_losssum[one_player_comb.private_cards.card1] -
         card_losssum[one_player_comb.private_cards.card2]) *
        lose_payoff;
  }
  if (this->debug) {
    cout << ("[showdown]") << endl;
    node->printHistory();
  }
  return payoffs;
}

DiscountedCfr::DiscountedCfr(vector<PrivateCards> *privateCards,
                             ActionNode &actionNode)
    : action_node(actionNode) {
  this->privateCards = privateCards;
  this->action_number = action_node.getChildrens().size();
  this->card_number = privateCards->size();

  this->r_plus = vector<float>(this->action_number * this->card_number);
  this->r_plus_sum = vector<float>(this->card_number);

  this->cum_r_plus = vector<float>(this->action_number * this->card_number);
}

void DiscountedCfr::setLastEV(const vector<float> &ev) {
  if (ev.size() != static_cast<size_t>(this->card_number))
    throw runtime_error(
        "setLastEV: size of EV vector does not match number of private cards");
  this->last_ev = ev;
}

bool DiscountedCfr::isAllZeros(const vector<float> &input_array) {
  for (float i : input_array) {
    if (i != 0)
      return false;
  }
  return true;
}

const vector<float> DiscountedCfr::getAverageStrategy() {
  vector<float> average_strategy;
  average_strategy = vector<float>(this->action_number * this->card_number);
  for (int private_id = 0; private_id < this->card_number; private_id++) {
    float r_plus_sum = 0;
    for (int action_id = 0; action_id < action_number; action_id++) {
      int index = action_id * this->card_number + private_id;
      r_plus_sum += this->cum_r_plus[index];
    }

    for (int action_id = 0; action_id < action_number; action_id++) {
      int index = action_id * this->card_number + private_id;
      if (r_plus_sum)
        average_strategy[index] = this->cum_r_plus[index] / r_plus_sum;
      else
        average_strategy[index] = 1.0 / this->action_number;
    }
  }
  return average_strategy;
}

const vector<float> DiscountedCfr::getcurrentStrategy() {
  return this->getcurrentStrategyNoCache();
}

void DiscountedCfr::copyStrategy(shared_ptr<DiscountedCfr> other_trainable) {
  shared_ptr<DiscountedCfr> trainable =
      dynamic_pointer_cast<DiscountedCfr>(other_trainable);
  this->r_plus.assign(trainable->r_plus.begin(), trainable->r_plus.end());
  this->cum_r_plus.assign(trainable->cum_r_plus.begin(),
                          trainable->cum_r_plus.end());
}

const vector<float> DiscountedCfr::getcurrentStrategyNoCache() {
  vector<float> current_strategy;
  current_strategy = vector<float>(this->action_number * this->card_number);
  if (this->r_plus_sum.empty()) {
    fill(current_strategy.begin(), current_strategy.end(),
         1.0 / this->action_number);
  } else {
    for (int action_id = 0; action_id < action_number; action_id++) {
      for (int private_id = 0; private_id < this->card_number; private_id++) {
        int index = action_id * this->card_number + private_id;
        if (this->r_plus_sum[private_id] != 0)
          current_strategy[index] =
              max(0.0f, this->r_plus[index]) / this->r_plus_sum[private_id];
        else
          current_strategy[index] = 1.0 / this->action_number;
      }
    }
  }
  return current_strategy;
}

void DiscountedCfr::updateRegrets(const vector<float> &regrets,
                                  int iteration_number,
                                  const vector<float> &reach_probs) {

  auto alpha_coef = pow(iteration_number, this->alpha);
  alpha_coef = alpha_coef / (1 + alpha_coef);

  fill(r_plus_sum.begin(), r_plus_sum.end(), 0);
  for (int action_id = 0; action_id < action_number; action_id++) {
    for (int private_id = 0; private_id < this->card_number; private_id++) {
      int index = action_id * this->card_number + private_id;
      float one_reg = regrets[index];

      this->r_plus[index] = one_reg + this->r_plus[index];
      if (this->r_plus[index] > 0) {
        this->r_plus[index] *= alpha_coef;
      } else {
        this->r_plus[index] *= beta;
      }

      this->r_plus_sum[private_id] += max(0.0f, this->r_plus[index]);
    }
  }
  vector<float> current_strategy = this->getcurrentStrategyNoCache();
  float strategy_coef =
      pow((float)iteration_number / (iteration_number + 1), gamma);
  for (int action_id = 0; action_id < action_number; action_id++) {
    for (int private_id = 0; private_id < this->card_number; private_id++) {
      int index = action_id * this->card_number + private_id;
      this->cum_r_plus[index] *= theta;
      this->cum_r_plus[index] += current_strategy[index] * strategy_coef;
    }
  }
}

json DiscountedCfr::dump_strategy(bool with_state) {
  if (with_state)
    throw runtime_error("state storage not implemented");

  json strategy;
  const vector<float> &average_strategy = this->getAverageStrategy();
  vector<GameActions> &game_actions = action_node.getActions();
  vector<string> actions_str;
  for (GameActions &one_action : game_actions) {
    actions_str.push_back(cleanActionString(one_action.toString()));
  }

  for (int i = 0; i < privateCards->size(); i++) {
    PrivateCards &one_private_card = (*privateCards)[i];
    vector<float> one_strategy(action_number + 1);
    for (int j = 0; j < action_number; j++) {
      int strategy_index = j * privateCards->size() + i;
      one_strategy[j] = average_strategy[strategy_index];
    }
    if (last_ev.size() == static_cast<size_t>(privateCards->size()))
      one_strategy[action_number] = last_ev[i];
    else
      one_strategy[action_number] = 0.0f;
    strategy[fmt::format("{}", one_private_card.toString())] = one_strategy;
  }

  json retjson;
  retjson["a"] = std::move(actions_str);
  retjson["s"] = std::move(strategy);
  return retjson;
}

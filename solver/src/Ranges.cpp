#include "Ranges.h"
#include <utility>

PrivateCards::PrivateCards() {}

PrivateCards::PrivateCards(int card1, int card2, float weight) {
  this->card1 = card1;
  this->card2 = card2;
  this->weight = weight;
  this->relative_prob = 0;
  this->card_vec = vector<int>{this->card1, this->card2};
  if (card1 > card2) {
    this->hash_code = card1 * 52 + card2;
  } else {
    this->hash_code = card2 * 52 + card1;
  }
  this->board_long = Card::boardInts2long(this->card_vec);
}

uint64_t PrivateCards::toBoardLong() { return this->board_long; }

int PrivateCards::hashCode() { return this->hash_code; }

string PrivateCards::toString() {
  if (card1 > card2) {
    return Card::intCard2Str(card1) + Card::intCard2Str(card2);
  } else {
    return Card::intCard2Str(card2) + Card::intCard2Str(card1);
  }
}

const vector<int> &PrivateCards::get_hands() const { return this->card_vec; }

PrivateCardsManager::PrivateCardsManager() {}

PrivateCardsManager::PrivateCardsManager(
    vector<vector<PrivateCards>> private_cards, int player_number,
    uint64_t initialboard) {
  this->private_cards = private_cards;
  this->player_number = player_number;
  this->card_player_index = vector<vector<int>>(52 * 52);
  for (int i = 0; i < 52 * 52; i++) {
    this->card_player_index[i] = vector<int>(this->player_number, -1);
  }

  for (int player_id = 0; player_id < player_number; player_id++) {
    vector<PrivateCards> privateCombos = private_cards[player_id];
    for (int i = 0; i < privateCombos.size(); i++) {
      PrivateCards one_private_combo = privateCombos[i];
      this->card_player_index[one_private_combo.hashCode()][player_id] = i;
    }
  }

  this->initialboard = initialboard;
  this->setRelativeProbs();
}

vector<PrivateCards> &PrivateCardsManager::getPreflopCards(int player) {
  return this->private_cards[player];
}

int PrivateCardsManager::indPlayer2Player(int from_player, int to_player,
                                          int index) {
  if (index < 0 || index >= this->getPreflopCards(from_player).size())
    throw runtime_error("index out of range");
  int to_player_index =
      this->card_player_index[this->private_cards[from_player][index]
                                  .hashCode()][to_player];
  if (to_player_index == -1) {
    return -1;
  } else {
    return to_player_index;
  }
}

vector<float> PrivateCardsManager::getInitialReachProb(int player,
                                                       uint64_t initialboard) {
  int cards_len = this->private_cards[player].size();
  vector<float> probs = vector<float>(cards_len);
  for (int i = 0; i < cards_len; i++) {
    PrivateCards pc = this->private_cards[player][i];
    if (Card::boardsHasIntercept(initialboard,
                                 Card::boardInts2long(pc.get_hands()))) {
      probs[i] = 0;
    } else {
      probs[i] = this->private_cards[player][i].weight;
    }
  }
  return probs;
}

void PrivateCardsManager::setRelativeProbs() {
  int players = this->private_cards.size();
  for (int player_id = 0; player_id < players; player_id++) {
    int oppo = 1 - player_id;
    float player_prob_sum = 0;

    for (int i = 0; i < this->private_cards[player_id].size(); i++) {
      float oppo_prob_sum = 0;
      PrivateCards *player_card = &this->private_cards[player_id][i];
      uint64_t player_long = Card::boardInts2long(player_card->get_hands());

      if (Card::boardsHasIntercept(player_long, this->initialboard)) {
        continue;
      }

      for (auto oppo_card : this->private_cards[oppo]) {
        uint64_t oppo_long = Card::boardInts2long(oppo_card.get_hands());
        if (Card::boardsHasIntercept(oppo_long, this->initialboard) ||
            Card::boardsHasIntercept(oppo_long, player_long)) {
          continue;
        }
        oppo_prob_sum += oppo_card.weight;
      }
      player_card->relative_prob = oppo_prob_sum * player_card->weight;
      player_prob_sum += player_card->relative_prob;
    }
    for (int i = 0; i < this->private_cards[player_id].size(); i++) {
      this->private_cards[player_id][i].relative_prob =
          this->private_cards[player_id][i].relative_prob / player_prob_sum;
    }
  }
}

RiverCombs::RiverCombs() {}

RiverCombs::RiverCombs(vector<int> board, PrivateCards private_cards, int rank,
                       int reach_prob_index) {
  this->board = board;
  this->rank = rank;
  this->private_cards = private_cards;
  this->reach_prob_index = reach_prob_index;
}

RiverRangeManager::RiverRangeManager() = default;

RiverRangeManager::RiverRangeManager(shared_ptr<HandRanker> handEvaluator) {
  this->handEvaluator = std::move(handEvaluator);
  this->maplock = std::make_shared<std::mutex>();
}

const vector<RiverCombs> &
RiverRangeManager::getRiverCombos(int player,
                                  const vector<PrivateCards> &riverCombos,
                                  const vector<int> &board) {
  uint64_t board_long = Card::boardInts2long(board);
  return this->getRiverCombos(player, riverCombos, board_long);
}

const vector<RiverCombs> &
RiverRangeManager::getRiverCombos(int player,
                                  const vector<PrivateCards> &preflopCombos,
                                  uint64_t board_long) {
  unordered_map<uint64_t, vector<RiverCombs>> *riverRanges;

  if (player == 0)
    riverRanges = &p1RiverRanges;
  else if (player == 1)
    riverRanges = &p2RiverRanges;
  else
    throw runtime_error(fmt::format("player {} not found", player));

  uint64_t key = board_long;

  this->maplock->lock();
  if (riverRanges->find(key) != riverRanges->end()) {
    const vector<RiverCombs> &retval = (*riverRanges)[key];
    this->maplock->unlock();
    return retval;
  }
  this->maplock->unlock();

  int count = 0;

  for (auto one_hand : preflopCombos) {
    if (!Card::boardsHasIntercept(one_hand.toBoardLong(), board_long))
      count++;
  }

  int index = 0;
  vector<RiverCombs> riverCombos = vector<RiverCombs>(count);

  for (int hand = 0; hand < preflopCombos.size(); hand++) {
    PrivateCards preflopCombo = preflopCombos[hand];

    if (Card::boardsHasIntercept(preflopCombo.toBoardLong(), board_long)) {
      continue;
    }

    int rank =
        this->handEvaluator->get_rank(preflopCombo.toBoardLong(), board_long);
    RiverCombs riverCombo =
        RiverCombs(Card::long2board(board_long), preflopCombo, rank, hand);
    riverCombos[index++] = riverCombo;
  }

  std::sort(riverCombos.begin(), riverCombos.end(),
            [](const RiverCombs &lhs, const RiverCombs &rhs) {
              return lhs.rank > rhs.rank;
            });

  this->maplock->lock();
  (*riverRanges)[key] = std::move(riverCombos);
  this->maplock->unlock();

  return (*riverRanges)[key];
}

vector<PrivateCards>
PrivateRangeConverter::rangeStr2Cards(string range_str,
                                      vector<int> initial_boards) {
  vector<string> range_list = string_split(range_str, ',');
  vector<PrivateCards> private_cards;

  for (string one_range : range_list) {
    PrivateCards this_card;
    vector<string> cardstr_arr = string_split(one_range, ':');
    if (cardstr_arr.size() > 2 || cardstr_arr.empty()) {
      throw runtime_error("':' number exceeded 2");
    }
    float weight = 1;

    one_range = cardstr_arr[0];
    if (cardstr_arr.size() == 2) {
      weight = atof(cardstr_arr[1].c_str());
    }
    if (weight <= 0.005) {
      continue;
    }

    int range_len = one_range.length();
    if (range_len == 3) {
      if (one_range.at(2) == 's') {
        char rank1 = one_range.at(0);
        char rank2 = one_range.at(1);
        if (rank1 == rank2)
          throw runtime_error(
              fmt::format("{}{}s is not a valid card desc", rank1, rank2));
        for (const string &one_suit : Card::getSuits()) {
          int card1 = Card::strCard2int(rank1 + one_suit);
          int card2 = Card::strCard2int(rank2 + one_suit);
          this_card = PrivateCards(card1, card2, weight);
          private_cards.push_back(this_card);
        }

      } else if (one_range.at(2) == 'o') {
        char rank1 = one_range.at(0);
        char rank2 = one_range.at(1);

        vector<string> suits = Card::getSuits();
        for (int i = 0; i < suits.size(); i++) {
          string one_suit = suits[i];
          int begin_index = rank1 == rank2 ? i : 0;
          for (int j = begin_index; j < suits.size(); j++) {
            string another_suit = suits[j];
            if (one_suit == another_suit) {
              continue;
            }
            int card1 = Card::strCard2int(rank1 + one_suit);
            int card2 = Card::strCard2int(rank2 + another_suit);
            if (Card::boardsHasIntercept(
                    Card::boardInts2long(vector<int>{card1, card2}),
                    Card::boardInts2long(initial_boards))) {
              continue;
            }
            this_card = PrivateCards(card1, card2, weight);
            private_cards.push_back(this_card);
          }
        }
      } else {
        throw runtime_error("format not recognize");
      }
    } else if (range_len == 2) {
      char rank1 = one_range.at(0);
      char rank2 = one_range.at(1);
      vector<string> suits = Card::getSuits();
      for (int i = 0; i < suits.size(); i++) {
        string one_suit = suits[i];
        int begin_index = rank1 == rank2 ? i : 0;
        for (int j = begin_index; j < suits.size(); j++) {
          string another_suit = suits[j];
          if (one_suit == another_suit && rank1 == rank2) {
            continue;
          }
          int card1 = Card::strCard2int(rank1 + one_suit);
          int card2 = Card::strCard2int(rank2 + another_suit);
          if (Card::boardsHasIntercept(
                  Card::boardInts2long(vector<int>{card1, card2}),
                  Card::boardInts2long(initial_boards))) {
            continue;
          }
          this_card = PrivateCards(card1, card2, weight);
          private_cards.push_back(this_card);
        }
      }

    } else
      throw runtime_error(
          fmt::format(" range str {} len not valid ", one_range));
  }

  for (int i = 0; i < private_cards.size(); i++) {
    for (int j = i + 1; j < private_cards.size(); j++) {
      PrivateCards one_cards = private_cards[i];
      PrivateCards another_cards = private_cards[j];
      if (one_cards.card1 == another_cards.card1 &&
          one_cards.card2 == another_cards.card2) {
        throw runtime_error(fmt::format("card {} {} duplicate",
                                        Card::intCard2Str(one_cards.card1),
                                        Card::intCard2Str(one_cards.card2)));
      }
      if (one_cards.card1 == another_cards.card2 &&
          one_cards.card2 == another_cards.card1) {
        throw runtime_error(fmt::format("card {} {} duplicate",
                                        Card::intCard2Str(one_cards.card1),
                                        Card::intCard2Str(one_cards.card2)));
      }
    }
  }

  vector<PrivateCards> private_cards_list(private_cards.size());
  for (int i = 0; i < private_cards.size(); i++) {
    private_cards_list[i] = private_cards[i];
  }
  return private_cards_list;
}

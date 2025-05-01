#ifndef DICT_RANKER_H
#define DICT_RANKER_H

#include "HandRanker.h"
#include "library.h"
#include <string>
#include <unordered_map>
#include <vector>

class DictRanker : public HandRanker {

public:
  DictRanker(const std::string &dic_dir, int lines);
  Rank compair(const std::vector<Card> &private_former,
               const std::vector<Card> &private_latter,
               const std::vector<Card> &public_board) override;
  Rank compair(const std::vector<int> &private_former,
               const std::vector<int> &private_latter,
               const std::vector<int> &public_board) override;

  int get_rank(const std::vector<Card> &private_hand,
               const std::vector<Card> &public_board) const override;
  int get_rank(const std::vector<int> &private_hand,
               const std::vector<int> &public_board) const override;
  int get_rank(uint64_t private_hand, uint64_t public_board) const override;

private:
  std::unordered_map<uint64_t, int> cardslong2rank;
  int getRank(const std::vector<Card> &cards) const;
  int getRank(const std::vector<int> &cards) const;
  static constexpr Rank compairRanks(int rank_former, int rank_latter) {
        if (rank_former < rank_latter) {
             // The smaller the rank the better
            return Rank::LARGER;
        } else if (rank_former > rank_latter) {
            return Rank::SMALLER;
        } else {
            return Rank::EQUAL;
        }
    }
};

#endif // DICT_RANKER

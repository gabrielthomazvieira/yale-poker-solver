#ifndef HAND_RANKER_H
#define HAND_RANKER_H
#include "CardsUtils.h"
#include "fmt/format.h"
#include <string>
#include <vector>

class HandRanker {
public:
  enum Rank { LARGER, EQUAL, SMALLER };
  HandRanker() = default;
  HandRanker(const std::string &dic_dir, int lines) {
    this->dic_dir = dic_dir;
    this->lines = lines;
  };
  virtual ~HandRanker() = default;
  virtual Rank compair(const std::vector<Card> &private_former,
                                const std::vector<Card> &private_latter,
                                const std::vector<Card> &public_board) = 0;
  virtual Rank compair(const std::vector<int> &private_former,
                                const std::vector<int> &private_latter,
                                const std::vector<int> &public_board) = 0;
  virtual int get_rank(const std::vector<Card> &private_hand,
                       const std::vector<Card> &public_board) const = 0;
  virtual int get_rank(const std::vector<int> &private_hand,
                       const std::vector<int> &public_board) const = 0;
  virtual int get_rank(uint64_t private_hand, uint64_t public_board) const = 0;

protected:
  std::string dic_dir;
  int lines{};
};

#endif // HAND_RANKER

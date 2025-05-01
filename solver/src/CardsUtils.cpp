#include "CardsUtils.h"
#include <array> // For std::array
#ifdef _MSC_VER
#include <intrin.h> // For _BitScanForward64
#endif

// --- Precomputed Lookups ---
namespace {

// Precompute all 52 card strings
std::array<std::string, 52> createCardStrings() {
  std::array<std::string, 52> strings;
  for (int i = 0; i < 52; ++i) {
    int rank = i / 4 + 2;
    int suit = i % 4;
    strings[i] = Card::rankToString(rank) + Card::suitToString(suit);
  }
  return strings;
}

const std::array<std::string, 52> cardIntToStringLUT = createCardStrings();

const std::array<const char *, 15> rankIntToStringLUT = {
    "?", "?", "2", "3", "4", "5", "6", "7",
    "8", "9", "T", "J", "Q", "K", "A"}; // Index matches rank integer (0 and 1
                                        // unused)

const std::array<const char *, 4> suitIntToStringLUT = {
    "c", "d", "h", "s"}; // Index matches suit integer

} // namespace

// --- Card Class Implementation ---

// Default Constructor
Card::Card() : card_int(-1), card_number_in_deck(-1) {} // Initialize members

// Constructor with string and deck index
Card::Card(string card_str, int card_num_in_deck)
    : card(card_str), card_number_in_deck(card_num_in_deck) {
  // Ensure the card string is valid before converting
  if (card_str.length() != 2) {
    throw runtime_error(
        fmt::format("Invalid card string format: {}", card_str));
  }
  this->card_int = Card::strCard2int(this->card);
}

// Constructor with just the card string
Card::Card(string card_str)
    : card(card_str),
      card_number_in_deck(-1) { // card_number_in_deck is unknown
  // Ensure the card string is valid before converting
  if (card_str.length() != 2) {
    throw runtime_error(
        fmt::format("Invalid card string format: {}", card_str));
  }
  this->card_int = Card::strCard2int(this->card);
}

// Getters
string Card::getCard() const { return this->card; }

int Card::getCardInt() const {
  if (this->card_int == -1) {
    throw runtime_error("Card integer is not initialized properly.");
  }
  return this->card_int;
}

int Card::getNumberInDeckInt() const {
  if (this->card_number_in_deck == -1) {
    throw runtime_error(
        "Card was not created as part of a standard deck or index is missing.");
  }
  return this->card_number_in_deck;
}

int Card::card2int(const Card &card_obj) {
  if (card_obj.card_int != -1) {
    return card_obj.card_int;
  }
  return strCard2int(card_obj.getCard()); // Fallback
}

int Card::strCard2int(const string &card_str) {
  if (card_str.length() != 2) {
    throw runtime_error(
        fmt::format("Invalid card string format for conversion: {}", card_str));
  }
  char rank_char = card_str.at(0);
  char suit_char = card_str.at(1);

  int rank_int = rankToInt(rank_char);
  int suit_int = suitToInt(suit_char);

  // (RankValue - 2) * NumberOfSuits + SuitValue
  return (rank_int - 2) * 4 + suit_int;
}

string Card::intCard2Str(int card_int) {
  if (card_int < 0 || card_int >= 52) {
    throw runtime_error(
        fmt::format("Invalid card integer for conversion: {}", card_int));
  }
  return cardIntToStringLUT[card_int];
}

// Static board representation utilities (using uint64_t bitmasks)
uint64_t Card::boardCards2long(const vector<string> &cards) {
  uint64_t board_long = 0;
  for (const string &card_str : cards) {
    board_long |= boardInt2long(strCard2int(card_str)); // Use bitwise OR
  }
  return board_long;
}

uint64_t Card::boardCard2long(const Card &card_obj) {
  return Card::boardInt2long(card_obj.getCardInt());
}

uint64_t Card::boardCards2long(const vector<Card> &cards) {
  uint64_t board_long = 0;
  for (const Card &card_obj : cards) {
    board_long |= boardInt2long(card_obj.getCardInt()); // Use bitwise OR
  }
  return board_long;
}

uint64_t Card::boardInt2long(int board_int) {
    if (board_int < 0 || board_int >= 52) {
        throw runtime_error(
            fmt::format("Card integer {} out of range (0-51)", board_int));
    }
    return (uint64_t)1 << board_int;
}

uint64_t Card::boardInts2long(const vector<int> &board_ints) {
  if (board_ints.empty() || board_ints.size() > 7) {
    throw runtime_error(
        fmt::format("Incorrect number of cards for board conversion: {}",
                    board_ints.size()));
  }
  uint64_t board_long = 0;
  for (int one_card_int : board_ints) {
    board_long |= boardInt2long(one_card_int); // Use bitwise OR
  }
  return board_long;
}

vector<int> Card::long2board(uint64_t board_long) {
  vector<int> board;
  board.reserve(7);

#ifdef _MSC_VER
  unsigned long index;
  while (_BitScanForward64(&index, board_long)) {
    board.push_back(static_cast<int>(index));
    board_long &= board_long - 1; // Clear LSB
  }
#elif defined(__GNUC__) || defined(__clang__)
  while (board_long != 0) {
    int index =
        __builtin_ctzll(board_long); // Count trailing zeros (index of LSB)
    board.push_back(index);
    board_long &= board_long - 1; // Clear LSB
  }
#else
  // Fallback
  for (int i = 0; i < 52; ++i) {
    if ((board_long >> i) & 1) {
      board.push_back(i);
    }
  }
#endif
  if (board.empty() || board.size() > 7) {
    throw runtime_error(fmt::format(
        "Incorrect number of cards decoded from bitmask: {}", board.size()));
  }
  return board;
}

vector<Card> Card::long2boardCards(uint64_t board_long) {
  vector<Card> board_cards;
  board_cards.reserve(7);

#ifdef _MSC_VER
  unsigned long index;
  while (_BitScanForward64(&index, board_long)) {
    if (index < 52) {
      board_cards.emplace_back(
          cardIntToStringLUT[index]); // Use LUT + emplace_back
    }
    board_long &= board_long - 1; // Clear LSB
  }
#elif defined(__GNUC__) || defined(__clang__)
  while (board_long != 0) {
    int index = __builtin_ctzll(board_long);
    // Directly use index for lookup and Card creation
    if (index < 52) {
      board_cards.emplace_back(
          cardIntToStringLUT[index]); // Use LUT + emplace_back
    }
    board_long &= board_long - 1;
  }
#else
  // Fallback
  vector<int> board_ints = long2board(board_long);
  for (int one_board_int : board_ints) {
    board_cards.emplace_back(Card::intCard2Str(
        one_board_int));
  }
  return board_cards;
#endif
  if (board_cards.empty() || board_cards.size() > 7) {
    throw runtime_error(
        fmt::format("Incorrect number of cards decoded from bitmask: {}",
                    board_cards.size()));
  }
  return board_cards;
}

string Card::suitToString(int suit) {
  if (suit < 0 || suit >= 4) {
    throw runtime_error(fmt::format("Invalid suit integer: {}", suit));
  }
  return suitIntToStringLUT[suit];
}

string Card::rankToString(int rank) {
  if (rank < 2 || rank > 14) {
    throw runtime_error(fmt::format("Invalid rank integer: {}", rank));
  }
  return rankIntToStringLUT[rank];
}

int Card::rankToInt(char rank_char) {
  switch (rank_char) {
  case '2':
    return 2;
  case '3':
    return 3;
  case '4':
    return 4;
  case '5':
    return 5;
  case '6':
    return 6;
  case '7':
    return 7;
  case '8':
    return 8;
  case '9':
    return 9;
  case 'T':
  case 't':
    return 10; // Allow lowercase T
  case 'J':
  case 'j':
    return 11; // Allow lowercase J
  case 'Q':
  case 'q':
    return 12; // Allow lowercase Q
  case 'K':
  case 'k':
    return 13; // Allow lowercase K
  case 'A':
  case 'a':
    return 14; // Allow lowercase A
  default:
    throw runtime_error(fmt::format("Invalid rank character: {}", rank_char));
  }
}

int Card::suitToInt(char suit_char) {
  switch (suit_char) {
  case 'c':
  case 'C':
    return 0; // Allow uppercase
  case 'd':
  case 'D':
    return 1; // Allow uppercase
  case 'h':
  case 'H':
    return 2; // Allow uppercase
  case 's':
  case 'S':
    return 3; // Allow uppercase
  default:
    throw runtime_error(fmt::format("Invalid suit character: {}", suit_char));
  }
}

vector<string> Card::getSuits() { return {"c", "d", "h", "s"}; }

// Utility
string Card::toString() const {
  return this->card; // Simply return the stored card string
}

// --- Deck Class Implementation ---

// Default constructor - creates an empty deck
Deck::Deck() = default; // Use default implementation

// Constructor to create a standard deck
Deck::Deck(const vector<string> &ranks_in, const vector<string> &suits_in)
    : ranks(ranks_in), suits(suits_in) {

  cards_str.reserve(ranks.size() * suits.size());
  cards.reserve(ranks.size() * suits.size()); // Reserve space for efficiency

  int card_num = 0; // Index for card_number_in_deck
  for (const string &one_rank : ranks) {
    for (const string &one_suit : suits) {
      string one_card_str = one_rank + one_suit;
      cards_str.push_back(one_card_str);
      // Create Card object and add it to the vector
      cards.emplace_back(one_card_str, card_num); // Use the Card constructor
      card_num++; // Increment the index for the next card
    }
  }
}

// Getter for the cards vector
vector<Card> &Deck::getCards() { return this->cards; }
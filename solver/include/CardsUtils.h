#ifndef CARDS_UTILS_H
#define CARDS_UTILS_H

#include "fmt/format.h"
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using namespace std;

// --- Card Class Definition ---
class Card {
private:
  string card;
  int card_int;
  int card_number_in_deck; // Represents the index (0-51) if part of a standard
                           // deck

public:
  // Constructors
  Card(); // Default constructor
  explicit Card(string card_str,
                int card_num_in_deck); // Constructor with string and deck index
  explicit Card(string card_str);      // Constructor with just the card string

  // Getters
  string getCard() const;         // Returns the card string (e.g., "As")
  int getCardInt() const;         // Returns the integer representation (0-51)
  int getNumberInDeckInt() const; // Returns the index in the deck (0-51)

  // Static conversion utilities
  static int card2int(const Card &card_obj); // Converts a Card object to its
                                             // integer representation
  static int strCard2int(const string &card_str); // Converts a card string to
                                                  // its integer representation
  static string intCard2Str(
      int card_int); // Converts an integer representation back to a card string

  // Static board representation utilities (using uint64_t bitmasks)
  static uint64_t
  boardCards2long(const vector<string>
                      &cards); // Converts a vector of card strings to a bitmask
  static uint64_t boardCard2long(
      const Card &card_obj); // Converts a single Card object to a bitmask
  static uint64_t
  boardCards2long(const vector<Card>
                      &cards); // Converts a vector of Card objects to a bitmask
  static uint64_t boardInts2long(
      const vector<int>
          &board_ints); // Converts a vector of card integers to a bitmask
  static uint64_t
  boardInt2long(int board_int); // Converts a single card integer to a bitmask

  static inline bool boardsHasIntercept(uint64_t board1, uint64_t board2) {
    return ((board1 & board2) != 0);
  };
  static vector<int>
  long2board(uint64_t board_long); // Converts a bitmask back to a vector of
                                   // card integers
  static vector<Card>
  long2boardCards(uint64_t board_long); // Converts a bitmask back to a vector
                                        // of Card objects

  // Static rank/suit utilities
  static string suitToString(
      int suit); // Converts suit integer (0-3) to string ("c", "d", "h", "s")
  static string
  rankToString(int rank); // Converts rank integer (2-14) to string ("2".."A")
  static int rankToInt(
      char rank_char); // Converts rank character ('2'..'A') to integer (2-14)
  static int suitToInt(char suit_char); // Converts suit character ('c', 'd',
                                        // 'h', 's') to integer (0-3)
  static vector<string> getSuits();     // Returns a vector of suit strings

  // Utility
  string toString() const; // Returns the card string (same as getCard)
};

// --- Deck Class Definition ---
class Deck {
public:
  // Constructors
  Deck(); // Default constructor (creates an empty deck)
  Deck(const vector<string> &ranks,
       const vector<string>
           &suits); // Creates a standard deck with given ranks/suits

  // Getter
  vector<Card> &
  getCards(); // Returns a reference to the vector of Card objects in the deck

private:
  vector<string> ranks; // Stores the rank strings used to build the deck
  vector<string> suits; // Stores the suit strings used to build the deck
  vector<string>
      cards_str;      // Stores the string representation of each card in order
  vector<Card> cards; // Stores the Card objects in the deck
};

#endif // CARDS_UTILS_H
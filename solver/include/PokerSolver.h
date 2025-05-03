#ifndef POKER_SOLVER_H
#define POKER_SOLVER_H

#include <string>
#include <vector>
#include "DictRanker.h"
#include "Ranges.h"
#include "Solver.h"
#include "library.h"
#include <fstream>
#include <stdexcept>
#include <string>
#include <msgpack.hpp>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <algorithm>
#include <SQLiteCpp/SQLiteCpp.h>
using std::ofstream;
using std::string;
using namespace std;

class PokerSolver
{
public:
    PokerSolver();
    PokerSolver(string ranks, string suits, string compairer_file, int compairer_file_lines);
    void load_game_tree(string game_tree_file);
    void build_game_tree(
        float oop_commit,
        float ip_commit,
        int current_round,
        int raise_limit,
        float small_blind,
        float big_blind,
        float stack,
        GameTreeBuildingSettings buildingSettings,
        float allin_threshold);
    void train(
        string p1_range,
        string p2_range,
        string boards,
        string log_file,
        int iteration_number,
        int print_interval,
        string algorithm,
        int warmup,
        float accuracy,
        bool use_isomorphism,
        int threads);
    void dump_strategy(string dump_file_base, int dump_rounds);

private:
    shared_ptr<DictRanker> compairer;
    Deck deck;
    shared_ptr<GameTree> game_tree;
    shared_ptr<Solver> solver;

public:
    const shared_ptr<GameTree> &getGameTree() const;
};

#endif // POKER_SOLVER_H

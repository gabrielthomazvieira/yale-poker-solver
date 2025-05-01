#ifndef BINDSOLVER_UTILS_H
#define BINDSOLVER_UTILS_H
#include <CardsUtils.h>
#include <Ranges.h>
#include <Solver.h>
#include <Nodes.h>
#include <regex>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <cmath>

inline std::string cleanActionString(const std::string &raw)
{
    std::stringstream in(raw);
    std::stringstream out;
    std::string token;
    bool first = true;

    static const std::regex num_re(
        R"(^[+-]?\d*\.?\d+(e[+-]?\d+)?$)", std::regex::icase);

    while (in >> token) {
        if (!first) out << ' ';
        first = false;

        /* numeric substrings ---------------------------------------- */
        if (std::regex_match(token, num_re)) {
            double v = std::stod(token);
            double rounded = std::round(v * 100.0) / 100.0;   // 2‑dp
            double as_int  = std::round(rounded);

            if (std::fabs(rounded - as_int) < 1e-9)           //  e.g. 25.00
                out << static_cast<int>(as_int);              //  -> "25"
            else
                out << std::fixed << std::setprecision(2)
                    << rounded;                               //  -> "25.50"
        }
        /* alphabetic substrings ------------------------------------ */
        else {
            std::transform(token.begin(), token.end(), token.begin(),
                           [](unsigned char c){ return std::tolower(c); });
            token[0] = static_cast<char>(std::toupper(token[0]));
            out << token;                                     //  "bet" -> "Bet"
        }
    }
    return out.str();
}

template <typename T>
void exchange_color(vector<T>& value,vector<PrivateCards> range,int rank1,int rank2){
#ifdef DEBUG
    if(value.size() != range.size()) throw runtime_error("size problem");
    if(rank1 >= rank2) throw runtime_error("rank value problem");
#endif
    if(value.empty())return;
    vector<int> self_ind = vector<int>(value.size());
    int privateint2ind[52 * 52 * 2] = {0};
    for(int i = 0;i < range.size();i ++){
        PrivateCards& pc = range[i];
        int card1 = pc.card1;
        int card2 = pc.card2;
        if(card1 > card2){
            int tmp = card1;
            card1 = card2;
            card2 = tmp;
        }
        self_ind[i] = card1 * 52 + card2;

        if(card1 % 4 == rank1) card1 = card1 - rank1 + rank2;
        else if(card1 % 4 == rank2) card1 = card1 - rank2 + rank1;

        if(card2 % 4 == rank1) card2 = card2 - rank1 + rank2;
        else if(card2 % 4 == rank2) card2 = card2 - rank2 + rank1;

        if(card1 > card2){
            int tmp = card1;
            card1 = card2;
            card2 = tmp;
        }
        privateint2ind[card1 * 52 + card2] = i;
    }

    for(int i = 0;i < range.size();i ++) {
        if(self_ind[i] == -1) continue;
        int ind = privateint2ind[self_ind[i]];
        //cout << range[i].toString() << " ";
        //cout << range[ind].toString() << endl;
        if(ind != i){
            self_ind[ind] = -1;
            T tmp = value[i];
            value[i] = value[ind];
            value[ind] = tmp;
        }
    }
    //throw runtime_error("exiting...here...");
}

#endif //BINDSOLVER_UTILS_H

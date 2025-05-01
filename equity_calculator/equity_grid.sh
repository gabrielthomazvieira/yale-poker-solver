#!/usr/bin/env bash
#  equity_grid.sh   – combo vs range equities, board‑aware, multi‑street
set -euo pipefail

echo -e "\n[DEBUG] -> Starting equity_grid.sh  (PID $$)"

################################################################################
# Arguments & helpers
################################################################################
FULL_MODE=false
# if last argument is --full, run flop, flop+turn, flop+turn+river separately
if [[ $# -gt 0 && "${!#}" == "--full" ]]; then
    FULL_MODE=true
    set -- "${@:1:$(($#-1))}"
fi

if [[ $# -lt 3 || $# -gt 5 ]]; then
    echo "Usage: $0 HERO_RANGE VIL_RANGE FLOP_BOARD [TURN_CARD] [RIVER_CARD] [--full]"
    exit 1
fi

HERO_RAW=$1
VIL_RAW=$2
FLOP_BOARD=$3
TURN_CARD=${4:-}
RIVER_CARD=${5:-}
CPU=$(nproc)

echo -e "\n[DEBUG] -> Starting equity_grid.sh  (PID $$)"
echo "[DEBUG] Full mode?     : $FULL_MODE"
echo "[DEBUG] Hero raw       : $HERO_RAW"
echo "[DEBUG] Villain raw    : $VIL_RAW"
echo "[DEBUG] Flop board     : $FLOP_BOARD"
echo "[DEBUG] Turn card      : ${TURN_CARD:-<none>}"
echo "[DEBUG] River card     : ${RIVER_CARD:-<none>}"
echo "[DEBUG] nproc          : $CPU"


# strip weights like :1.0
clean() { sed -E 's/:[0-9.]+//g' <<<"$1"; }
HERO=$(clean "$HERO_RAW")
VIL=$(clean "$VIL_RAW")
echo "[DEBUG] After weight-strip, hero → $HERO"
echo "[DEBUG] After weight-strip, vil  → $VIL"

# expand bare ranks into suited/offsuit
expand_unsuffixed() {
    local rng="$1" tok out=()
    IFS=',' read -ra toks <<<"$rng"
    for tok in "${toks[@]}"; do
        if [[ ${#tok} -eq 2 && ${tok:0:1} != ${tok:1:1} ]]; then
            out+=("${tok}s" "${tok}o")
        else
            out+=("$tok")
        fi
    done
    IFS=','; echo "${out[*]}"
}

HERO=$(expand_unsuffixed "$HERO")
VIL=$(expand_unsuffixed "$VIL")

echo "[DEBUG] After expansion, hero → $HERO"
echo "[DEBUG] After expansion, vil  → $VIL"

export HERO VIL
export OMP_NUM_THREADS=1

################################################################################
# Helpers for evaluations
################################################################################
get_range_eq() {
    ./holdem-eval --format ${BOARD:+-b $BOARD} "$1" "$2" |
        tail -n +2 | head -1 | awk '{gsub(/%/, ""); print $NF}'
}
run_eval() {
    local HV=$1 HAND=$2 RANGE2 eq
    [[ $HV == H ]] && RANGE2=$VIL || RANGE2=$HERO
    eq=$( ./holdem-eval --format ${BOARD:+-b $BOARD} \
        "$HAND" "$RANGE2" | tail -n +2 | head -1 | awk '{gsub(/%/, ""); print $NF}' )
    printf '%s %s %.6f\n' "$HV" "$HAND" "$eq"
}
export -f run_eval get_range_eq

################################################################################
# Core per-street processing function
################################################################################
process_street() {
    local ST_NAME=$1
    local CURR_BOARD=$2
    echo "[DEBUG] -> Processing $ST_NAME (board=$CURR_BOARD)"
    BOARD="$CURR_BOARD"; export BOARD

    echo "[DEBUG] -> Expanding ranges & filtering board …"
    EXPAND_JSON=$(python3 - "$HERO" "$VIL" "$BOARD" 2>expand.stderr <<'PY'
import sys,json
ranks="AKQJT98765432"; suits="hdcs"; idx={r:i for i,r in enumerate(ranks)}

def pp(r):     return [f"{r}{a}{r}{b}" for i,a in enumerate(suits) for b in suits[i+1:]]
def sx(r1,r2): return [f"{r1}{s}{r2}{s}" for s in suits]
def ox(r1,r2): return [f"{r1}{s1}{r2}{s2}" for s1 in suits for s2 in suits if s1!=s2]
def bx(r1,r2): return sx(r1,r2)+ox(r1,r2)

def tokens(rng):
    for t in rng.split(","):
        t=t.strip()
        if not t: continue
        if "+" in t:
            base=t.rstrip("+")
            if len(base)==2:
                for r in ranks[idx[base[0]]::-1]:
                    yield r+r
            else:
                r1,r2,flag=base
                for r in ranks[idx[r2]::-1]:
                    yield f"{r1}{r}{flag}"
        elif "-" in t:
            lo,hi=t.split("-")
            if len(lo)==len(hi)==2 and lo[0]==hi[0]==lo[1]==hi[1]:
                for r in ranks[idx[lo[0]]:idx[hi[0]]-1:-1]:
                    yield r+r
            else:
                raise ValueError(f"Unsupported token {t}")
        else:
            yield t

def expand(rng):
    out=[]
    for t in tokens(rng):
        if len(t)==2:   out+=pp(t[0])
        elif len(t)==3:
            r1,r2,flag=t
            out+= sx(r1,r2) if flag=="s" else ox(r1,r2) if flag=="o" else bx(r1,r2)
    return out

hero,vil = expand(sys.argv[1]), expand(sys.argv[2])

brd=sys.argv[3]
if brd:
    board=[brd[i:i+2] for i in range(0,len(brd),2)]
    hero=[c for c in hero if c[:2] not in board and c[2:] not in board]
    vil =[c for c in vil  if c[:2] not in board and c[2:] not in board]

print(json.dumps({"hero":hero,"vil":vil}))
PY
) || true   # capture exit code manually

EXPAND_RC=$?
if [[ $EXPAND_RC -ne 0 || -z "$EXPAND_JSON" ]]; then
    echo "[ERROR] Range expander failed (exit=$EXPAND_RC).  Details:"
    cat expand.stderr
    exit 1
fi
rm -f expand.stderr

[[ $EXPAND_JSON == \{* ]] || { echo "[ERROR] Expander output is not JSON"; exit 1; }

echo "[DEBUG] Expander JSON length: ${#EXPAND_JSON} bytes"
    echo "[DEBUG] -> Building raw combo list …"
    COMBO_OUT=$(python3 - "$HERO" "$VIL" "$BOARD" 2>combo.err <<'PY'
import sys, json
ranks="AKQJT98765432"; suits="hdcs"; idx={r:i for i,r in enumerate(ranks)}

def pp(r):     return [f"{r}{a}{r}{b}" for i,a in enumerate(suits) for b in suits[i+1:]]
def sx(r1,r2): return [f"{r1}{s}{r2}{s}" for s in suits]
def ox(r1,r2): return [f"{r1}{s1}{r2}{s2}" for s1 in suits for s2 in suits if s1!=s2]
def bx(r1,r2): return sx(r1,r2)+ox(r1,r2)

def tokens(rng):
    for t in rng.split(","):
        t=t.strip()
        if not t: continue
        if "+" in t:
            base=t.rstrip("+")
            if len(base)==2:
                for r in ranks[idx[base[0]]::-1]:
                    yield r+r
            else:
                r1,r2,flag=base
                for r in ranks[idx[r2]::-1]:
                    yield f"{r1}{r}{flag}"
        elif "-" in t:
            lo,hi=t.split("-")
            if len(lo)==len(hi)==2 and lo[0]==hi[0]==lo[1]==hi[1]:
                for r in ranks[idx[lo[0]]:idx[hi[0]]-1:-1]:
                    yield r+r
            else:
                raise ValueError(f"Unsupported token {t}")
        else:
            yield t

def expand(rng):
    out=[]
    for t in tokens(rng):
        if len(t)==2:   out+=pp(t[0])
        elif len(t)==3:
            r1,r2,flag=t
            out+= sx(r1,r2) if flag=="s" else ox(r1,r2) if flag=="o" else bx(r1,r2)
    return out

hero,vil = expand(sys.argv[1]), expand(sys.argv[2])

brd=sys.argv[3]
if brd:
    board=[brd[i:i+2] for i in range(0,len(brd),2)]
    hero=[c for c in hero if c[:2] not in board and c[2:] not in board]
    vil =[c for c in vil  if c[:2] not in board and c[2:] not in board]

for c in hero: print("H",c)
for c in vil : print("V",c)
PY
) || { echo "[ERROR] Combo builder failed for $ST_NAME"; cat combo.err; exit 1; }
    [[ -s combo.err ]] && { echo "[PY-WARN]"; cat combo.err; }

    rm -f combo.err
    readarray -t COMBOS <<<"$COMBO_OUT"
    (( ${#COMBOS[@]} > 0 )) || { echo "[ERROR] No combos after expansion for $ST_NAME"; exit 1; }

    echo "[DEBUG] -> Launching holdem-eval workers for $ST_NAME …"
    if command -v parallel &>/dev/null; then
        printf '%s\n' "${COMBOS[@]}" | parallel --jobs "$CPU" --colsep ' ' run_eval {1} {2}
    else
        printf '%s\n' "${COMBOS[@]}" | xargs -n2 -P"$CPU" bash -c 'run_eval "$0" "$1"'
    fi | sort > "tmp_equity_${ST_NAME}.tsv"

    HERO_RANGE_EQ=$(get_range_eq "$HERO" "$VIL")
    VIL_RANGE_EQ=$(get_range_eq "$VIL" "$HERO")
    export HERO_RANGE_EQ VIL_RANGE_EQ
    echo "[DEBUG] Hero-range equity ($ST_NAME): ${HERO_RANGE_EQ}%"
    echo "[DEBUG] Villain-range equity ($ST_NAME): ${VIL_RANGE_EQ}%"

    echo "[DEBUG] -> Packing results for $ST_NAME …"
    python3 - "$ST_NAME" <<'PY'
import sys, os, msgpack
st = sys.argv[1]
out = {"hero": {}, "villain": {}}
with open(f"tmp_equity_{st}.tsv") as f:
    for ln in f:
        parts = ln.strip().split()
        if len(parts) != 3: continue
        who, hand, eq = parts
        out["hero" if who == "H" else "villain"][hand] = float(eq)
out["hero_range"] = float(os.environ["HERO_RANGE_EQ"])
out["villain_range"] = float(os.environ["VIL_RANGE_EQ"])
with open(f"equity_{st}.msgpack", "wb") as f:
    f.write(msgpack.packb(out, use_bin_type=True))
PY
    gzip -9f "equity_${ST_NAME}.msgpack"
    rm -f "tmp_equity_${ST_NAME}.tsv"
    echo "equity_${ST_NAME}.msgpack.gz created (size: $(du -h equity_${ST_NAME}.msgpack.gz | cut -f1))"
}

################################################################################
# Execute for streets, branching on FULL_MODE
################################################################################
if $FULL_MODE; then
    # full: run every street
    process_street flop  "$FLOP_BOARD"
    [[ -n "$TURN_CARD" ]] && process_street turn  "${FLOP_BOARD}${TURN_CARD}"
    [[ -n "$RIVER_CARD" ]] && process_street river "${FLOP_BOARD}${TURN_CARD}${RIVER_CARD}"
else
    # single: only the deepest street available
    if [[ -n "$RIVER_CARD" ]]; then
        process_street river "${FLOP_BOARD}${TURN_CARD}${RIVER_CARD}"
    elif [[ -n "$TURN_CARD" ]]; then
        process_street turn  "${FLOP_BOARD}${TURN_CARD}"
    else
        process_street flop  "$FLOP_BOARD"
    fi
fi

echo "[DEBUG] -> Finished selected streets."

"""Builds the narration script (display text for subtitles + spoken text for TTS) for the demo
video from a recording made by scripts/record-demo.mjs. Numbers come from the recorded run.

usage: python3 scripts/video/script.py <recording_dir>   -> <recording_dir>/narration.json
"""
import json
import re
import sys
from pathlib import Path

REC = Path(sys.argv[1])
rec = json.loads((REC / "recording.json").read_text())
state = rec["state"]
terms, totals = state["terms"], state["totals"]

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def words(n: int) -> str:
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else "-" + ONES[n % 10])
    rest = n % 100
    return ONES[n // 100] + " hundred" + ("" if rest == 0 else " " + words(rest))


def money_display(cents: int) -> str:
    return f"${cents // 100}" if cents % 100 == 0 else f"${cents / 100:.2f}"


def money_spoken(cents: int) -> str:
    d, c = divmod(cents, 100)
    s = f"{words(d)} dollars" if d != 1 else "one dollar"
    return s + (f" and {words(c)} cents" if c else "")


SPOKEN_ITEMS = {
    "CT01": "dark roast coffee beans", "CT02": "ground coffee", "CT03": "decaf coffee", "CT04": "coffee pods",
    "CT05": "black tea", "CT06": "herbal tea", "MK01": "oat milk", "MK02": "almond milk", "MK03": "whole milk",
    "MK04": "half and half", "MK05": "soy milk", "SN01": "vegan trail mix", "SN02": "sea salt crackers",
    "SN03": "chocolate chip cookies", "SN04": "veggie chips", "SN05": "protein bars", "SN06": "popcorn",
    "SN08": "dried mango",
}
bought = [r for r in state["ledger"] if r["status"] == "captured"]
names = [SPOKEN_ITEMS.get(r.get("productId"), r["item"].lower()) for r in bought]
items = (", ".join(names[:-1]) + " and " + names[-1]) if len(names) > 1 else (names[0] if names else "Nothing")
items = items[0].upper() + items[1:]
n_cap = len(bought)
espresso = next((r["amountCents"] for r in state["ledger"] if r.get("productId") == "KT01"), 24900)

# Each sentence: display text with {money:...} placeholders resolved for both forms.
VALUES = {
    "hold": terms["budgetCents"], "cap": terms["perItemCapCents"], "spent": totals["netSpentCents"],
    "released": totals["releasedCents"], "espresso": espresso,
}


def money_adj(cents: int) -> str:
    # "an eighty-dollar hold" (whole dollars only; cents read as a plain amount)
    d, c = divmod(cents, 100)
    return f"{words(d)}-dollar" if not c else money_spoken(cents)


def article(spoken: str) -> str:
    return "an" if spoken[:1] in "aeiou" else "a"


def render(text: str):
    def disp(m):
        key = m.group(1)
        if key.startswith("a_"):
            v = VALUES[key[2:]]
            return f"{article(money_adj(v))} {money_display(v)}"
        return money_display(VALUES[key.removesuffix("_adj")])

    def spoken(m):
        key = m.group(1)
        if key.startswith("a_"):
            v = VALUES[key[2:]]
            return f"{article(money_adj(v))} {money_adj(v)}"
        if key.endswith("_adj"):
            return money_adj(VALUES[key.removesuffix("_adj")])
        return money_spoken(VALUES[key])

    display = re.sub(r"\{(\w+)\}", disp, text)
    say = re.sub(r"\{(\w+)\}", spoken, text)
    for a, b in [
        (r"\bAG Grid\b", "A G Grid"), (r"\bAI\b", "A-I"), (r"\bSDK\b", "S-D-K"), (r"\bIDs\b", "I-Ds"),
        (r"\bv6\b", "version six"), (r"\b12\b", "twelve"), (r"\bred-team\b", "red team"), (r"\bAUTHORIZE\b", "authorize"),
    ]:
        say = re.sub(a, b, say)
    return {"display": display, "spoken": say}


cats = len(terms["allowedCategories"])
SHOTS = [
    ("card:title", None, ["AI agents are starting to shop for us.",
                          "But today you either hand them your card, or you approve every single purchase."]),
    ("start", "type_start", ["Allowance is the middle ground: the agent's budget is a PayPal authorization hold, so it can only spend what you approved."]),
    ("type_start", "drafted", ["I describe an errand in plain English: coffee, oat milk and snacks for twelve people, two of them vegan, under {hold}."]),
    ("drafted", "popup_open", [f"Cloudflare Workers AI turns it into a mandate: {{a_hold}} hold, at most {{cap}} per purchase, {words(cats)} allowed categories and a shopping list.",
                               "I can edit any of it before I approve."]),
    ("popup_open", "popup_done", ["Then I approve it once with PayPal.",
                                  "The PayPal JavaScript SDK v6 opens the sandbox checkout for an order with intent AUTHORIZE."]),
    ("popup_done", "run_click", ["Nothing is charged yet. PayPal places {a_hold} hold, and the mandate is signed and bound to that authorization."]),
    ("run_click", "shopped", ["Now the agent shops on its own: a Mistral model on Workers AI, calling a buy tool.",
                              "Every line passes 12 code checks and an independent AI auditor before it becomes a PayPal partial capture against the hold."]),
    ("shopped", "redteam_click", [f"{items}: {{spent}} in {words(n_cap)} PayPal captures.",
                                  "The AG Grid ledger shows the AI's reasoning, the firewall verdict, the auditor's note and PayPal's capture IDs for every line."]),
    ("redteam_click", "tooltip", ["What if the agent gets hijacked?",
                                  "The red-team drill tries a gift card, a sponsored listing that tells AI agents to ignore the budget, a {espresso_adj} espresso machine, a runaway quantity and a made-up product."]),
    ("tooltip", "redteam_end", ["The firewall blocks all five, and nothing reaches PayPal."]),
    ("redteam_end", "gift_done", ["Even when someone asks the agent in chat to buy a gift card, the signed mandate wins: the agent tries, and the firewall says no."]),
    ("gift_done", "mandates_view", ["When the errand is done, I release the rest.",
                                    "Allowance voids the authorization, {released} goes straight back to the buyer, and AI writes a recap grounded in the ledger."]),
    ("mandates_view", "end", ["Every allowance is tracked in AG Grid, with PayPal's authorization state and the AI recap.",
                              "And if the free AI quota runs out, Allowance keeps working in rules-only mode."]),
    ("card:end", None, ["Allowance. PayPal holds the money, AI runs the errand, and you stay in control."]),
]

out = {"shots": []}
for i, (a, b, sentences) in enumerate(SHOTS):
    out["shots"].append({"id": i, "from": a, "to": b, "sentences": [render(s) for s in sentences]})
(REC / "narration.json").write_text(json.dumps(out, indent=1))
for s in out["shots"]:
    for x in s["sentences"]:
        print(f"[{s['id']:2}] {x['display']}")

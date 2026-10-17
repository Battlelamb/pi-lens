-------------------------- MODULE FlightDetails --------------------------
EXTENDS Naturals, TLC
CONSTANT SharedVerdict
VARIABLES pending, latch, joined, settled, observed
vars == <<pending, latch, joined, settled, observed>>
Init == /\ pending = FALSE /\ latch = "empty" /\ joined = FALSE
        /\ settled = FALSE /\ observed = "empty"
Start == /\ ~pending /\ ~settled /\ pending' = TRUE
         /\ UNCHANGED <<latch, joined, settled, observed>>
Evict == /\ pending /\ latch' = "replacement"
         /\ UNCHANGED <<pending, joined, settled, observed>>
Join == /\ pending /\ joined' = TRUE
        /\ UNCHANGED <<pending, latch, settled, observed>>
Settle == /\ pending /\ joined
          /\ pending' = FALSE /\ settled' = TRUE
          /\ observed' = IF SharedVerdict \/ latch # "replacement"
                          THEN "transient" ELSE "empty"
          /\ UNCHANGED <<latch, joined>>
Next == Start \/ Evict \/ Join \/ Settle
Spec == Init /\ [][Next]_vars
NoLostTransient == settled => observed = "transient"
=============================================================================

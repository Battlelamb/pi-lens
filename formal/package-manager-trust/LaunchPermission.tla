-------------------------- MODULE LaunchPermission --------------------------
EXTENDS TLC
CONSTANT IndependentClassification
VARIABLES trust, owned, project, admitted, judged
vars == <<trust, owned, project, admitted, judged>>
Init == /\ trust \in {"unknown", "untrusted", "trusted"}
        /\ owned \in BOOLEAN /\ project \in BOOLEAN /\ admitted = FALSE /\ judged = FALSE
Classified == project /\ (IndependentClassification \/ trust # "trusted")
Launch == /\ judged' = TRUE
          /\ admitted' = (~Classified \/ (trust = "trusted" /\ owned))
          /\ UNCHANGED <<trust, owned, project>>
Spec == Init /\ [][Launch]_vars
NoUnownedProjectExecution == admitted /\ project => trust = "trusted" /\ owned
NoDroppedAllowed == judged /\ (~project \/ (trust = "trusted" /\ owned)) => admitted
=============================================================================

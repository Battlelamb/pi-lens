-------------------------- MODULE FinalSelection --------------------------
EXTENDS TLC
VARIABLES trust, project, phase, admitted
vars == <<trust, project, phase, admitted>>
Init == /\ trust \in {"unknown", "untrusted", "trusted"}
        /\ project \in BOOLEAN /\ phase = "discovery" /\ admitted = FALSE
Replace == /\ phase = "discovery"
           /\ phase' = "selected"
           /\ trust' \in {"unknown", "untrusted", "trusted"}
           /\ project' \in BOOLEAN
           /\ UNCHANGED admitted
Launch == /\ phase = "selected"
          /\ phase' = "spawn"
          /\ admitted' = (~project \/ trust = "trusted")
          /\ UNCHANGED <<trust, project>>
Next == Replace \/ Launch
Spec == Init /\ [][Next]_vars
NoUntrustedProjectExecution == admitted => ~project \/ trust = "trusted"
NoDroppedOutside == phase = "spawn" /\ ~project => admitted
=============================================================================

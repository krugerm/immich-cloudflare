-- Stream A: login_failures keys are now namespaced (`login:<email>`, `pin:<userId>`). Old rows used the bare email,
-- and a bare-email row could be `pin:<id>` sent as a login email, so all existing rows are dropped instead of rewritten.
-- Counters only live for 15 minutes, so at most one window of failure counts is forgotten.
DELETE FROM login_failures;

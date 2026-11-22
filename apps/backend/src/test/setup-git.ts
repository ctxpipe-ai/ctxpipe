// A git command that writes objects (commit, fetch, merge) starts a detached
// `git maintenance run --auto`. After about 100 loose objects, that process
// repacks `.git/objects` after the command returns, so a test that removes its
// temporary repository fails with ENOTEMPTY (CTX-1497). Each git process of a
// test worker inherits this configuration and starts no maintenance. The
// variables add to GIT_CONFIG_GLOBAL, which some tests set.
process.env.GIT_CONFIG_COUNT = "2"
process.env.GIT_CONFIG_KEY_0 = "maintenance.auto"
process.env.GIT_CONFIG_VALUE_0 = "false"
process.env.GIT_CONFIG_KEY_1 = "gc.auto"
process.env.GIT_CONFIG_VALUE_1 = "0"

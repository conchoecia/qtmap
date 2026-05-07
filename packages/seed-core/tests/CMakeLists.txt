cmake_minimum_required(VERSION 3.20)

# Plain assert-based tests. Each test is a small standalone executable that
# exit-codes 0 on success, non-zero on failure. CTest integration is just
# `add_test(NAME ... COMMAND ...)`.

# Native-only — Emscripten builds skip the test executables.
if(EMSCRIPTEN)
    return()
endif()

set(QTQC_TEST_TARGETS
    test_hash
    test_sha256
    test_minimizer
    test_shard_codec
)

foreach(t IN LISTS QTQC_TEST_TARGETS)
    add_executable(${t} ${t}.c)
    target_link_libraries(${t} PRIVATE seed_core)
    add_test(NAME ${t} COMMAND ${t})
endforeach()

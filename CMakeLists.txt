cmake_minimum_required(VERSION 3.20)
project(qtqc_mm2browser
    VERSION 0.0.0
    LANGUAGES C
    DESCRIPTION "Browser-native long-read mapper: shared C core for native CLI + WebAssembly")

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# Warnings: treat unused-variable / format / shadow as errors in our code.
if(CMAKE_C_COMPILER_ID MATCHES "Clang|GNU")
    add_compile_options(
        -Wall -Wextra -Wpedantic
        -Wshadow -Wformat=2 -Wcast-align -Wstrict-prototypes
        -Wmissing-prototypes -Wnull-dereference
        -fno-strict-aliasing
        # Implicit declarations of pointer-returning POSIX functions collapse
        # to `int` and silently truncate on LP64. Make that a hard build error
        # so the failure mode surfaces at compile time, not as a runtime SEGV.
        -Werror=implicit-function-declaration
        -Werror=int-conversion
    )
    if(CMAKE_BUILD_TYPE STREQUAL "Release")
        add_compile_options(-O3)
    endif()
endif()

# Emscripten-specific: don't error on long-double promotion etc.
if(EMSCRIPTEN)
    add_compile_options(-Wno-unused-command-line-argument)
endif()

enable_testing()

add_subdirectory(packages/seed-core)

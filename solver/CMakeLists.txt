cmake_minimum_required(VERSION 3.15)
project(bindSolver)
set(CMAKE_OSX_DEPLOYMENT_TARGET 10.7)

message(STATUS "Build type: ${CMAKE_BUILD_TYPE}")
# ─── compiler defaults ───────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Unified per-config flags (avoid accidental overwrite)
add_compile_definitions(_FILE_OFFSET_BITS=64 _LARGEFILE_SOURCE)

# Diagnostics
add_compile_options("$<$<COMPILE_LANGUAGE:CXX>:-Wall;-Wextra;-Wpedantic>")

# Optimised release w/ auto-vectorisation & LTO
add_compile_options("$<$<CONFIG:Release>:-O3;-march=native;-flto;-funsafe-math-optimizations>")
add_link_options($<$<CONFIG:Release>:-flto>)

# Debug symbols
add_compile_options($<$<CONFIG:Debug>:-g>)

if (CMAKE_HOST_WIN32)
    set(WINDOWS 1)
elseif (CMAKE_HOST_WIN64)
    set(WINDOWS 1)
elseif (CMAKE_HOST_APPLE)
    set(MACOS 1)
elseif (CMAKE_HOST_UNIX)
    set(LINUX 1)
endif ()

if(NOT CMAKE_INSTALL_PREFIX_INITIALIZED)
  set(CMAKE_INSTALL_PREFIX "$ENV{HOME}/local" CACHE PATH "Default install path" FORCE)
endif()

#openmp
FIND_PACKAGE(OpenMP REQUIRED)
IF(OPENMP_FOUND)
    MESSAGE("openmp found")
    # Propagate with an interface target
    add_library(openmp INTERFACE)
    target_link_libraries(openmp INTERFACE OpenMP::OpenMP_C OpenMP::OpenMP_CXX)
ENDIF()

# SQLite3 dev library
find_package(SQLite3 REQUIRED)
message(STATUS "Found SQLite3: ${SQLite3_LIBRARIES}")

# SQLiteCpp
add_subdirectory(ext/SQLiteCpp)

# string format
include_directories(ext/fmt/include ext/fmt)
add_subdirectory(ext/fmt/)

# msgpack
include_directories(ext/msgpack-c/include)
add_subdirectory(ext/msgpack-c)

# zstd
set(ZSTD_BUILD_PROGRAMS OFF CACHE BOOL "Disable zstd CLI build")
set(ZSTD_BUILD_TESTS OFF CACHE BOOL "Disable zstd test build")
add_subdirectory(ext/zstd/build/cmake)

include_directories(include)

AUX_SOURCE_DIRECTORY(src lib_src)

AUX_SOURCE_DIRECTORY(include lib_src)

add_library(YalePoker
        ${lib_src}
        )

target_link_libraries(YalePoker PUBLIC fmt openmp SQLite::SQLite3 SQLiteCpp libzstd_static)

add_executable(console_solver src/main.cpp)
target_link_libraries(console_solver  YalePoker      openmp)

INSTALL(DIRECTORY "${PROJECT_SOURCE_DIR}/resources" DESTINATION "${PROJECT_SOURCE_DIR}/install" OPTIONAL)
INSTALL(TARGETS console_solver DESTINATION "${PROJECT_SOURCE_DIR}/install")

#include "GetInput.h"
#include "argparse.hpp"
#include <iostream>
#include <stdexcept>
#include <string>

int main(int argc, const char **argv) {
  ArgumentParser parser;
  parser.addArgument("-i", "--input_file", /*num_args=*/1, /*optional=*/false);

  try {
    parser.parse(argc, argv);
  } catch (const std::runtime_error &err) {
    std::cerr << "Error parsing arguments: " << err.what() << std::endl;
    return 1;
  }

  std::string json_config_file;
  try {
    json_config_file = parser.retrieve<std::string>("input_file");
  } catch (const std::runtime_error &err) {
    std::cerr << "Error retrieving input file path: " << err.what()
              << std::endl;
    return 1;
  }

  std::string resource_dir = "./resources";

  try {
    GetInput clt = GetInput(resource_dir);
    clt.loadConfigFromJsonFile(json_config_file);
    clt.buildTreeFromConfig();
    clt.solveFromConfig();
    clt.dumpResultFromConfig();
    std::cout << "\nProcessing finished based on configuration in: "
              << json_config_file << std::endl;

  } catch (const std::exception &e) {
    std::cerr << "\nAn error occurred during processing: " << e.what()
              << std::endl;
    return 1;
  }

  return 0;
}
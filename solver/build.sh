#!/bin/bash

set -e  # Exit immediately if any command fails

rm -rf build install
mkdir build
cd build
cmake ..
make
make install
cd ../install

echo "✅ Build and installation complete."

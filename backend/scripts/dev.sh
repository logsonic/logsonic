#!/bin/bash

# Ensure the script fails on any error
set -e

# Create tmp directory if it doesn't exist
mkdir -p tmp

# Run air with the config file
~/go/bin/air -c .air.toml 
#!/usr/bin/env sh
set -eu
: "${JWT_ACCESS_SECRET:?set JWT_ACCESS_SECRET}"
: "${JWT_REFRESH_SECRET:?set JWT_REFRESH_SECRET}"
docker compose up -d --build

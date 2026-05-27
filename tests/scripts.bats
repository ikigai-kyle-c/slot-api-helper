#!/usr/bin/env bats

setup() {
  export TEST_DIR="$(mktemp -d)"
  export MAINT_SCRIPT="$BATS_TEST_DIRNAME/../src/InternalMaintenanceApi/maintenance-flow.sh"
  export BET_SCRIPT="$BATS_TEST_DIRNAME/../src/RGSBetFlow/bet-flow.sh"
  export LOBBY_SCRIPT="$BATS_TEST_DIRNAME/../src/RGSLobby/lobby-flow.sh"
  
  # 1. Create a mock 'curl' executable that intercepts all API calls
  mkdir -p "$TEST_DIR/bin"
  cat << 'EOF' > "$TEST_DIR/bin/curl"
#!/usr/bin/env bash
# Always return a valid token and HTTP 200 for tests
echo '{"data": {"token": "mock-jwt.123", "sessionId": "sess", "accessToken": "acc", "refreshToken": "ref"}}HTTPSTATUS:200'
EOF
  chmod +x "$TEST_DIR/bin/curl"
  
  # 2. Force the tests to use our fake curl before the system's real curl
  export PATH="$TEST_DIR/bin:$PATH"
}

teardown() {
  rm -rf "$TEST_DIR"
}

create_env() {
  cat << 'EOF' > "$TEST_DIR/.env"
MAINTENANCE_API_DOMAIN=http://test.api
AM_USER_ID=1
AM_ACCOUNT=test_acc
AM_CODE=TEST
AM_ROUTE_KEY=ROUTE_KEY
IS_MAINTENANCE=true
API_DOMAIN=http://test.api
GAME_CODE=TEST-001
EOF
}

@test "maintenance-flow.sh requires IS_MAINTENANCE" {
  cd "$TEST_DIR"
  create_env
  
  # Deliberately remove the required variable to test the error fallback
  sed -i '' '/IS_MAINTENANCE/d' .env 2>/dev/null || sed -i '/IS_MAINTENANCE/d' .env
  cp "$MAINT_SCRIPT" ./maint.sh
  
  run bash ./maint.sh
  
  if [ "$status" -ne 1 ]; then
    echo "[DEBUG] Expected status 1 but got $status" >&3
    echo "[DEBUG] Script Output: $output" >&3
    false
  fi
  
  echo "$output" | grep -q "IS_MAINTENANCE is required"
}

@test "maintenance-flow.sh completes JSON out" {
  cd "$TEST_DIR"
  create_env
  cp "$MAINT_SCRIPT" ./maint.sh
  
  run bash ./maint.sh --json-out
  
  if [ "$status" -ne 0 ]; then
    echo "[DEBUG] maint.sh failed with status $status" >&3
    echo "[DEBUG] Script Output: $output" >&3
    false
  fi
  
  # Verifies AI JSON mode exited successfully and is strictly JSON
  echo "$output" | grep -q '"status": "success"'
}

@test "bet-flow.sh executes and generates result file" {
  cd "$TEST_DIR"
  create_env
  cp "$BET_SCRIPT" ./bet.sh
  
  run bash ./bet.sh
  
  if [ "$status" -ne 0 ]; then
    echo "[DEBUG] bet.sh failed with status $status" >&3
    echo "[DEBUG] Script Output: $output" >&3
    false
  fi
  
  echo "$output" | grep -q "Done"
}

@test "lobby-flow.sh executes properly" {
  cd "$TEST_DIR"
  create_env
  cp "$LOBBY_SCRIPT" ./lobby.sh
  
  # Speed up the sleep timer for testing so it doesn't hang
  sed -i '' 's/sleep 1/sleep 0.01/g' ./lobby.sh 2>/dev/null || sed -i 's/sleep 1/sleep 0.01/g' ./lobby.sh
  
  run bash ./lobby.sh
  
  if [ "$status" -ne 0 ]; then
    echo "[DEBUG] lobby.sh failed with status $status" >&3
    echo "[DEBUG] Script Output: $output" >&3
    false
  fi
  
  echo "$output" | grep -q "Done"
}
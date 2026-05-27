#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load environment variables from the script directory .env if present.
if [[ -f "${SCRIPT_DIR}/.env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/.env"
  set +o allexport
fi

DEFAULT_DOMAIN="${MAINTENANCE_API_DOMAIN:-localhost:8080}"
SIGNATURE="${API_SIGNATURE:-rgs-local-signature}"
CONTENT_TYPE="application/json"
CACHE_FILE="${SCRIPT_DIR}/.am-token-cache.json"

DOMAIN="${1:-${DEFAULT_DOMAIN}}"
GAME_CODE="${2:-${MAINTENANCE_GAME_CODE:-LGS-006}}"

if [[ "${DOMAIN}" != http://* && "${DOMAIN}" != https://* ]]; then
  DOMAIN="http://${DOMAIN}"
fi
BASE_URL="${DOMAIN%/}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "ERROR: ${name} is required. Please set it in ${SCRIPT_DIR}/.env."
    exit 1
  fi
}

validate_is_maintenance() {
  require_env "IS_MAINTENANCE"

  if [[ "${IS_MAINTENANCE}" != "true" && "${IS_MAINTENANCE}" != "false" ]]; then
    echo "ERROR: IS_MAINTENANCE must be true or false, got: ${IS_MAINTENANCE}"
    exit 1
  fi
}

validate_am_env() {
  require_env "AM_ACCOUNT"
  require_env "AM_CODE"
  require_env "AM_ROUTE_KEY"
  require_env "AM_USER_ID"
}

require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required to parse token responses."
    exit 1
  fi
}

parse_body() {
  printf '%s' "$1" | sed 's/HTTPSTATUS:[0-9]\{3\}$//'
}

parse_status() {
  printf '%s' "$1" | sed -n 's/.*HTTPSTATUS:\([0-9]\{3\}\)$/\1/p'
}

http_post() {
  local url="$1"; shift
  curl --silent --show-error --location --request POST "$url" "$@" --write-out 'HTTPSTATUS:%{http_code}'
}

http_patch() {
  local url="$1"; shift
  curl --silent --show-error --location --request PATCH "$url" "$@" --write-out 'HTTPSTATUS:%{http_code}'
}

load_cached_token() {
  if [[ ! -f "${CACHE_FILE}" ]]; then
    return 0
  fi

  local cached_base_url
  local cached_account
  local cached_code
  local cached_route_key
  local cached_user_id

  cached_base_url=$(jq -r '.baseUrl // empty' "${CACHE_FILE}" 2>/dev/null || true)
  cached_account=$(jq -r '.account // empty' "${CACHE_FILE}" 2>/dev/null || true)
  cached_code=$(jq -r '.code // empty' "${CACHE_FILE}" 2>/dev/null || true)
  cached_route_key=$(jq -r '.routeKey // empty' "${CACHE_FILE}" 2>/dev/null || true)
  cached_user_id=$(jq -r '.userId // empty' "${CACHE_FILE}" 2>/dev/null || true)

  if [[ "${cached_base_url}" != "${BASE_URL}" ||
        "${cached_account}" != "${AM_ACCOUNT}" ||
        "${cached_code}" != "${AM_CODE}" ||
        "${cached_route_key}" != "${AM_ROUTE_KEY}" ||
        "${cached_user_id}" != "${AM_USER_ID}" ]]; then
    printf "Cached AM token does not match current .env, requesting a new one.\n"
    return 0
  fi

  AM_TOKEN=$(jq -r '.token // empty' "${CACHE_FILE}" 2>/dev/null || true)
  AM_SESSION_ID=$(jq -r '.sessionId // empty' "${CACHE_FILE}" 2>/dev/null || true)

  if [[ -n "${AM_TOKEN}" && -n "${AM_SESSION_ID}" ]]; then
    printf "Using cached AM token.\n"
    printf "Cached AM session id: %s\n" "${AM_SESSION_ID}"
  fi
}

save_cached_token() {
  jq -n \
    --arg baseUrl "${BASE_URL}" \
    --arg account "${AM_ACCOUNT}" \
    --arg code "${AM_CODE}" \
    --arg routeKey "${AM_ROUTE_KEY}" \
    --arg userId "${AM_USER_ID}" \
    --arg token "${AM_TOKEN}" \
    --arg sessionId "${AM_SESSION_ID}" \
    '{
      baseUrl: $baseUrl,
      account: $account,
      code: $code,
      routeKey: $routeKey,
      userId: $userId,
      token: $token,
      sessionId: $sessionId,
      savedAt: now
    }' > "${CACHE_FILE}"
}

is_token_invalid_response() {
  local status="$1"
  local body="$2"

  [[ "${status}" == "401" ]] || printf '%s' "${body}" | grep -Ei 'invalid|expired|unauthorized' >/dev/null 2>&1
}

request_am_token() {
  local payload
  local response
  local body
  local status

  payload=$(jq -n \
    --arg account "${AM_ACCOUNT}" \
    --arg code "${AM_CODE}" \
    --arg routeKey "${AM_ROUTE_KEY}" \
    --argjson userId "${AM_USER_ID}" \
    '{
      userId: $userId,
      account: $account,
      code: $code,
      permission: [
        {
          routeKey: $routeKey,
          methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "*"]
        }
      ]
    }')

  printf "[1/2] Requesting AM token from %s/v1/service/am/token ...\n" "${BASE_URL}"
  response=$(http_post "${BASE_URL}/v1/service/am/token" \
    --header "accept: application/json" \
    --header "x-signature: ${SIGNATURE}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "AM token response:\n%s\n" "${body}"

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: AM token request failed with HTTP status ${status}."
    exit 1
  fi

  AM_TOKEN=$(printf '%s' "${body}" | jq -r '.data.token // empty')
  AM_SESSION_ID=$(printf '%s' "${body}" | jq -r '.data.sessionId // empty')

  if [[ -z "${AM_TOKEN}" ]]; then
    echo "ERROR: 無法從 AM token 回傳的 data.token 擷取 token。"
    exit 1
  fi

  if [[ -z "${AM_SESSION_ID}" ]]; then
    echo "ERROR: 無法從 AM token 回傳的 data.sessionId 擷取 sessionId。"
    exit 1
  fi

  if [[ "${AM_TOKEN}" != *.*.* ]]; then
    echo "ERROR: data.token 看起來不是 JWT 格式，請檢查回傳。"
    exit 1
  fi

  printf "Using AM token from data.token.\n"
  printf "AM session id: %s\n" "${AM_SESSION_ID}"
  save_cached_token
}

patch_game_maintenance() {
  local payload
  local response
  local body
  local status

  payload=$(jq -n --argjson isMaintenance "${IS_MAINTENANCE}" '{isMaintenance: $isMaintenance}')

  printf "[2/2] Patching %s maintenance=%s ...\n" "${GAME_CODE}" "${IS_MAINTENANCE}"
  response=$(http_patch "${BASE_URL}/v1/internal/game/${GAME_CODE}/maintenance" \
    --header "accept: application/json" \
    --header "x-access-token: ${AM_TOKEN}" \
    --header "Content-Type: ${CONTENT_TYPE}" \
    --data "${payload}")

  body=$(parse_body "${response}")
  status=$(parse_status "${response}")

  printf "Maintenance response:\n%s\n" "${body}"

  if is_token_invalid_response "${status}" "${body}"; then
    return 1
  fi

  if [[ "${status}" != "200" ]]; then
    echo "ERROR: maintenance PATCH failed with HTTP status ${status}."
    exit 1
  fi

  if [[ "$(printf '%s' "${body}" | jq -r '.error // empty')" != "" ]]; then
    echo "ERROR: maintenance PATCH returned a non-empty error."
    exit 1
  fi
}

require_jq
validate_am_env
validate_is_maintenance
load_cached_token

if [[ -z "${AM_TOKEN:-}" ]]; then
  request_am_token
fi

if ! patch_game_maintenance; then
  printf "Cached AM token is invalid or expired, requesting a new token and retrying...\n"
  request_am_token
  if ! patch_game_maintenance; then
    echo "ERROR: maintenance PATCH failed even after refreshing AM token."
    exit 1
  fi
fi

printf "Done. Token confirmed from data.token and maintenance request succeeded.\n"

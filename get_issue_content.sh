#!/bin/bash
# get_issue_content.sh — Fetch full GitHub issue/PR context with all comments
# in chronological order, formatted as markdown.
#
# Usage:
#   get_issue_content.sh <owner>/<repo>/<number>
#   get_issue_content.sh <owner> <repo> <number>
#   get_issue_content.sh <github-url>        (issue or PR URL)

set -euo pipefail

# ── Parse arguments ──────────────────────────────────────────────────
if [ $# -eq 1 ]; then
  # Could be owner/repo/number or a full URL
  arg="$1"
  if [[ "$arg" =~ ^https?://github\.com/([^/]+)/([^/]+)/(issues|pull)/([0-9]+) ]]; then
    OWNER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"
    KIND="${BASH_REMATCH[3]}"   # "issues" or "pull"
    NUMBER="${BASH_REMATCH[4]}"
    ISSUE_REF="issues/${NUMBER}"  # GH API path: pull requests are also under /issues
  elif [[ "$arg" =~ ^([^/]+)/([^/]+)/([0-9]+)$ ]]; then
    OWNER="${BASH_REMATCH[1]}"
    REPO="${BASH_REMATCH[2]}"
    NUMBER="${BASH_REMATCH[3]}"
    ISSUE_REF="issues/${NUMBER}"
  else
    echo "Error: expected owner/repo/number or GitHub URL, got: $arg" >&2
    exit 1
  fi
elif [ $# -eq 3 ]; then
  OWNER="$1"
  REPO="$2"
  NUMBER="$3"
  ISSUE_REF="issues/${NUMBER}"
else
  echo "Usage: get_issue_content.sh <owner>/<repo>/<number>" >&2
  echo "       get_issue_content.sh <owner> <repo> <number>" >&2
  echo "       get_issue_content.sh <github-url>" >&2
  exit 1
fi

REPO_SLUG="${OWNER}/${REPO}"

# ── Fetch issue ─────────────────────────────────────────────────────
ISSUE_JSON=$(gh api "repos/${REPO_SLUG}/${ISSUE_REF}" \
  --jq '{title: .title, body: .body, url: .html_url, author: .user.login, created: .created_at}')

TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body')
URL=$(echo "$ISSUE_JSON" | jq -r '.url')
AUTHOR=$(echo "$ISSUE_JSON" | jq -r '.author')
CREATED=$(echo "$ISSUE_JSON" | jq -r '.created')

# ── Fetch comments ──────────────────────────────────────────────────
COMMENTS_JSON=$(gh api "repos/${REPO_SLUG}/${ISSUE_REF}/comments" \
  --paginate \
  --jq '.[] | {author: .user.login, body: .body, created: .created_at}')

# ── Output ──────────────────────────────────────────────────────────
echo "Source: ${URL}"
echo ""
echo "# ${TITLE}"
echo ""
echo "**@${AUTHOR}** opened on ${CREATED}"
echo ""
if [ -n "$BODY" ]; then
  echo "$BODY"
else
  echo "*(no description)*"
fi

# Render comments in chronological order (API returns them this way)
if [ -n "$COMMENTS_JSON" ]; then
  echo ""
  echo "---"
  echo ""
  echo "## Comments"
  echo ""

  while IFS= read -r comment; do
    [ -z "$comment" ] && continue
    c_author=$(echo "$comment" | jq -r '.author')
    c_body=$(echo "$comment" | jq -r '.body')
    c_created=$(echo "$comment" | jq -r '.created')
    echo "### @${c_author} commented on ${c_created}"
    echo ""
    echo "$c_body"
    echo ""
  done < <(echo "$COMMENTS_JSON" | jq -c '.')
fi

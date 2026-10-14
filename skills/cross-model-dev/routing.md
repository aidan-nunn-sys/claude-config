# Routing table

The `json` block is read by the route tool: it sets the router and the effort bands. If it doesn't
parse, the defaults are used and each pick's `why` says so. Everything else in this file is
advice the router reads; edit it freely.

```json
{
  "router": { "backend": "codex", "model": "gpt-6-luna", "effort": "low" },
  "bands": {
    "low":    { "impl": ["low", "medium"],  "review": ["low", "medium"], "haiku": true },
    "medium": { "impl": ["low", "medium"],  "review": ["low", "medium"], "haiku": true },
    "high":   { "impl": ["medium", "high"], "review": ["medium", "max"], "haiku": false },
    "xhigh":  { "impl": ["high", "xhigh"],  "review": ["high", "max"],   "haiku": false },
    "max":    { "impl": ["high", "xhigh"],  "review": ["high", "max"],   "haiku": false }
  }
}
```

Bands are keyed by the orchestrator's effort. Hard tasks at xhigh or max also get a read-only Sol
review.

## Relative quota weight (1 = cheapest), input / output

| Backend | Model | Input | Output | Notes |
|---|---|---|---|---|
| codex | gpt-6.1-sol | 3 | 2 | default implementer and plan reviewer |
| codex | gpt-6-luna | 1 | 1 | router |
| claude | sonnet | 2 | 4 | default reviewer (native Agent tool) |
| claude | haiku | 1 | 1 | trivial reviews |
| agy | gemini-3.8-flash-low/medium/high | 1 | 1 | Google quota; good when Claude and Codex are ahead of pace |
| agy | claude-sonnet-4-6 | 2 | 3 | Claude model on Google quota |
| copilot | auto | 5 | 5 | Student plan: 200 credits/month, ~4–5 requests; last resort |

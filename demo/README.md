# Demo: Email Check Action Plan

This demo shows the full Kiro Orchestra workflow without needing real email/SFDC access.

## How to run

1. Start Orchestra: `npm start`
2. Start all agents (Settings → Start All)
3. In chat, say:

```
Read the emails in the demo/emails/ folder, categorize them by priority, and produce an HTML action plan report with execute buttons.
```

## What happens

1. **Master** creates a Task with stages
2. **Workers** read the 5 demo emails in parallel
3. **Master** reviews results, produces HTML report with:
   - Priority categories (🔴 urgent / 🟡 medium / 🟢 low)
   - Action options per email (reply / forward / skip)
   - Email draft suggestions
   - ▶ Execute buttons (Orchestra integration)
4. **You** open the HTML report, check items, click Execute
5. **Master** receives your decisions, dispatches workers
6. **Workers** execute (simulated) + update HTML with ✅

## Demo emails

| # | From | Topic | Priority |
|---|------|-------|----------|
| 1 | Sarah Chen (Partner) | PoC timeline + GPU check | 🔴 Urgent |
| 2 | Mike Johnson (Customer) | Billing spike $2.4K→$8.9K | 🔴 Urgent |
| 3 | Lisa Wang (Enterprise) | Architecture review meeting | 🟡 Medium |
| 4 | AWS Insider | Newsletter | 🟢 Low (skip) |
| 5 | CRM System | Opp stage change notification | 🟢 Low (FYI) |

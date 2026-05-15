# Auto-Reply Workflow Setup in GHL

## Workflow: "Interested Lead → Book a Call"

### Trigger
- Type: Inbound SMS / Message Reply
- Tag condition: contact has tag `mystery-caller-audit`

### Condition (If/Else)
Message body contains ANY of these keywords:
- yes, sure, interested, how much, pricing, cost, more info,
  tell me more, sounds good, absolutely, definitely, love to,
  when, available, schedule, book, call, demo

### Action if INTERESTED → Send SMS:
```
Hi! Thanks for getting back to me 😊 I'd love to share what we've 
put together for you. It's a quick 15-min call — here's my calendar 
to pick a time that works: clinics.amelia.im/widget/booking/amelia-sales-call
```

### Action if NOT interested → Tag + Remove
- Add tag: `not-interested`
- Remove from audit workflow

---

## Setup Steps in GHL

1. Go to **Automation → Workflows → New Workflow**
2. Name it: "Audit Lead Auto-Reply"
3. Add trigger: **Customer Replied**
4. Add If/Else branch with keywords above
5. Add SMS action with the message above
6. Add "Add Tag" action: `interested-lead`
7. Publish

---

## Calendly Setup
Make sure you have a Calendly link set up:
- 15-min "AI Demo" event type
- Buffer time: 15min before/after
- Availability: Mon-Fri 9am-6pm your timezone

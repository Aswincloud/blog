---
title: "A talking front gate: Sonoff door sensor → Alexa, and why it whispers at dawn"
date: 2026-07-02
description: "A door sensor that makes Alexa announce 'door open' — with a twist: it whispers between 6 and 9am so it doesn't blast the house awake."
slug: "main-gate-door-announce"
---

Small, satisfying automation: when the main gate opens, an Amazon Echo announces **"Door open."** Battery door sensor, no wiring, done in an evening. But two details make it pleasant to live with rather than annoying.

## The hardware

A **Sonoff DW2-Wi-Fi** door/window sensor — battery powered, talks to the eWeLink cloud. In Home Assistant I pull it in via the excellent [SonoffLAN](https://github.com/AlexxIT/SonoffLAN) integration, which gives me a clean `binary_sensor` that's `on` when the gate is open.

One honest caveat: the DW2 is a **sleeping cloud sensor**. It only phones home on a state change, and Sonoff throttles real-time updates. So there's sometimes a second or two of lag. For a door announcement that's fine; for anything safety-critical you'd want a wired or Zigbee sensor.

## Detail 1: it whispers early in the morning

A full-volume "DOOR OPEN" at 6am when someone leaves for a walk is a great way to wake the whole house. So the announcement uses Alexa's SSML whisper effect between 6–9am, and normal voice otherwise:

```yaml
message: >-
  {% set h = now().hour %}
  {% if h >= 6 and h < 9 %}
    <speak><amazon:effect name="whispered">Door open</amazon:effect></speak>
  {% else %}
    Door open
  {% endif %}
```

Little touches like this are the difference between an automation you keep and one you disable after a week.

## Detail 2: only fire on a real open

The trigger is specifically the `off → on` edge (closed → open), not just "state is on":

```yaml
triggers:
- platform: state
  entity_id: binary_sensor.main_gate_door
  from: 'off'
  to: 'on'
```

Why the explicit `from`/`to`? Because on a Home Assistant restart, a sensor can briefly report `unavailable` and then `on` — which a naive "to: on" trigger treats as an event, announcing "door open" every time HA reboots. Pinning `from: 'off'` means it only fires on a genuine closed→open transition.

## Takeaway

The gadget is trivial. The polish — whisper hours, restart-proof triggering — is what makes it something the household actually likes instead of tolerates. That's the recurring theme across all my home-automation projects: **the last 20% of thoughtfulness is 80% of whether people keep it on.**

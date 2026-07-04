---
title: "One automation to watch every battery sensor in the house"
date: 2026-06-30
description: "A single daily Home Assistant automation that checks all my battery-powered sensors and only speaks up when one is actually running low — announced on Alexa and mirrored to Telegram."
slug: "daily-battery-check"
---

The problem with battery-powered sensors is you forget they have batteries — until one dies silently and you notice a week later that a door or motion sensor stopped reporting. This is a single automation that checks them all, once a day, and only bothers me when there's something to act on.

## The design

Every day at 12:30pm it loops over my battery sensors, and if any is below 30% it announces which one(s) — on Alexa **and** Telegram. If everything's healthy, it stays silent. No daily "all batteries fine" nag.

```yaml
- id: battery_low_daily_check
  alias: 'Battery: daily low check'
  triggers:
  - platform: time
    at: '12:30:00'
  variables:
    threshold: 30
    sensors:
      Door sensor: sensor.door_battery
      Inside motion: sensor.inside_motion_battery
      Outside motion: sensor.outside_motion_battery
    low: >-
      {% set ns = namespace(items=[]) %}
      {% for name, eid in sensors.items() %}
        {% set v = states(eid) %}
        {% if v not in ['unknown','unavailable','none', None] and (v | float(101)) < threshold %}
          {% set ns.items = ns.items + [name ~ ' at ' ~ (v | float | round) ~ ' percent'] %}
        {% endif %}
      {% endfor %}
      {{ ns.items | join(', ') }}
  conditions:
  - condition: template
    value_template: '{{ low | length > 0 }}'
  actions:
  - data:
      message: 'Low battery warning. {{ low }}.'
      data:
        type: tts
    action: notify.alexa_media_echo
  - data:
      message: '🔋 Low battery: {{ low }}.'
    action: rest_command.telegram_notify
  mode: single
```

## The details that matter

**It skips glitch readings.** Cheap battery gauges occasionally report `unavailable` or `unknown`, or briefly spike to a wrong value. The template explicitly filters those out (`v not in ['unknown','unavailable','none', None]`) so I don't get a false "0 percent!" alarm during a momentary dropout.

**It names the culprit.** Instead of a vague "a battery is low," it says exactly which sensor and its level — "Door sensor at 25 percent" — so I know what to grab a battery for.

**A once-a-day snapshot is naturally glitch-proof.** I considered making it event-driven (fire the instant a battery drops below 30%), but that's fragile — battery readings are noisy and would false-trigger. A daily check at a fixed time is immune to momentary noise: worst case it catches a bad reading one day and is fine the next.

## Telegram + a real-world gotcha

The alert mirrors to Telegram via a `rest_command` that hits the Bot API directly. Worth noting: my home ISP intermittently blocks `api.telegram.org`. When that happens the REST call just fails silently (Home Assistant's `rest_command` is `continue_on_error` by default) and the Alexa announcement still works — then Telegram resumes on its own when the block lifts. Graceful degradation for free.

## Takeaway

The trick isn't the code — it's the restraint: **only speak when there's something to do.** An automation that announces good news every day gets ignored (or disabled). One that stays quiet until it matters is one you actually trust.

---
title: "Good Night Alert: an ESP32, an LDR, and three bugs I didn't expect"
date: 2026-07-04
description: "I wanted my Alexa to say 'good night' when I switch off the bedroom light. The gadget was trivial. Getting it reliable taught me more than the gadget did."
slug: "good-night-alert"
---

The idea was simple: **when I turn off the bedroom tubelight at night, have Alexa say "Good night."**

The gadget is a weekend project. What actually took the time — and what's worth writing down — was making it *reliable*: three separate bugs, each one a good lesson in "the tutorial never mentions this."

## The setup

- **ESP32-C3** running [ESPHome](https://esphome.io), reporting to **Home Assistant**
- A **digital LDR module** (LM393 comparator + light sensor, with a threshold potentiometer) pointed at the tubelight
- HA fires the announcement to an Amazon Echo when the light goes off — but only 9–11pm, and only if the TV is also off

The design principle (borrowed from my water-tank sensor project): **the ESP exposes one dumb sensor; all the logic lives in Home Assistant.** That way tweaking behaviour is a config change, not a re-flash.

## Bug 1: the LDR was reading backwards

I flashed it, wired the LDR's digital-out to GPIO4, and set `inverted: true` in ESPHome (my assumption about the module's polarity).

Then I turned the light off — and the sensor flipped to **"lit."** Backwards.

I only caught it because I checked the *timestamped history* instead of trusting the label:

```
21:30:00  DARK   ← light was actually ON
21:34:57  LIT    ← I turned the light OFF here
```

The light-off produced a **dark→lit** transition — the exact opposite of what my automation was waiting for. These comparator modules come in both active-high and active-low variants; mine was the opposite of what I'd assumed. Fix: `inverted: false`.

**Lesson:** verify sensor polarity by toggling the real thing and watching the state — never trust the assumed logic level.

## Bug 2: renaming the sensor moved the entity

Once it worked, I renamed the sensor from "Tubelight Dark" to the clearer "Tubelight Off." Reflashed. The automation went silent again.

Home Assistant had regenerated the entity ID *and* prepended the device's area:

```
binary_sensor.goodnight_ldr_tubelight_off          ← what I expected
binary_sensor.living_room_goodnight_ldr_tubelight_off   ← what HA actually created
```

My automation trigger still pointed at the old name, so it never fired.

**Lesson:** after any rename in ESPHome/HA, re-check the *actual* entity ID. The area prefix bites people constantly.

## Bug 3: the one that had bitten a different automation

While debugging, I found my *welcome-home* automation (a separate project) had been dead for days. Root cause: a cooldown built as "turn on a flag → wait 3 minutes → turn off the flag." If Home Assistant restarts during those 3 minutes, the flag never turns off — it's **stuck on forever**, silently blocking the automation.

The fix is a pattern I now use everywhere: instead of a latching flag + delay, gate on the automation's own `last_triggered` timestamp:

```yaml
- condition: template
  value_template: >-
    {{ this.attributes.last_triggered is none
       or (as_timestamp(now()) - as_timestamp(this.attributes.last_triggered)) > 1800 }}
```

That survives restarts because Home Assistant persists `last_triggered`. No state to get stuck.

**Lesson:** any "do X, wait, undo X" automation is fragile across restarts. Prefer stateless/timestamp-based logic.

## The final automation

```yaml
- id: goodnight_tube_off
  alias: 'Good night: tubelight off 9-11pm'
  triggers:
  - platform: state
    entity_id: binary_sensor.living_room_goodnight_ldr_tubelight_off
    from: 'off'          # off = light ON
    to: 'on'             # on  = light OFF
    for:
      seconds: 2         # debounce flicker
  conditions:
  - condition: time
    after: '21:00:00'
    before: '23:00:00'
  - condition: template          # only if the TV is also off
    value_template: "{{ states('media_player.samsung_tv') == 'off' }}"
  - condition: template          # restart-safe 30-min cooldown
    value_template: >-
      {{ this.attributes.last_triggered is none
         or (as_timestamp(now()) - as_timestamp(this.attributes.last_triggered)) > 1800 }}
  actions:
  - data:
      message: 'Good night'
      data:
        type: tts
        volume: 1.0
    action: notify.alexa_media_echo
  mode: single
```

The "TV must also be off" condition is the touch I like most — it means flicking the light while watching a movie won't trigger it. It only fires when I'm genuinely going to bed.

## A note on power

The ESP is USB-powered and always on. I briefly considered deep-sleep to save power, then did the math: the whole thing draws well under a watt — roughly one unit of electricity every couple of months. Deep-sleep would've saved pennies a year while making it far less reliable. **Always-on was the correct engineering choice, not the lazy one.**

## Takeaway

The "project" — light off → Alexa speaks — was an afternoon. The *reliability* — polarity verification, entity-ID discipline, restart-safe state, sensible power design — is the part that separates a demo from something you actually live with. Those three bugs are the real content.

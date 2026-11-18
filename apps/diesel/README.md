# Diesel

The diesel particulate filter (DPF) and the rest of a B47 / B57's exhaust after-treatment, on the centre screen,
read from the engine unit (DDE, diagnostic address `0x12`) and the AdBlue unit (SCR, `0x0B`) over the head unit's own
diagnostic link. **Read-only by construction:** every request goes through `kit/runtime/readonly-diag.js`, which lets
nothing but `22` (ReadDataByIdentifier) leave the head unit; the app cannot start, stop or reset a regeneration.

> **Status: experimental.** The identifiers and their scalings come from the engine units' SGBDs (the public
> [EDIABAS reference](https://emdzej.github.io/ediabasx-docs-sgbd/)), each checked field by field against the SGBD's
> own tables, but not yet against a running car. The *Details* tab shows every value with its identifier and the
> reply's bytes: a photo of it (or Settings > QR log) is what's needed to confirm them.

## Pages

| Tab | Shows |
|---|---|
| **DPF** | Soot against the regeneration point, the soot model, ash and the filter life left, the pressure drop across the filter, the exhaust heat into it (and into the oxidation catalyst); FILTER OK / REGENERATION DUE / REGENERATING with the soot burnt, the time and distance it has run; the distance and engine time since the last one, the next one (the average interval less the distance since), the count; the soot over the last 1,000 km. |
| **Regenerations** | Each regeneration the app followed: start, the distance before it, how long it took, the distance, soot before and after, peak heat, done or stopped early. Until the first, the engine unit's own last five (the odometer at each, the distances between them). |
| **AdBlue** | Level (the AdBlue unit's tank) and range, NOx before and after the SCR catalyst and the share removed (only with the catalyst warm and both sensors reading), the catalyst's temperature, the stored average conversion and the AdBlue quality. A car without AdBlue says so. |
| **Engine** | The EGR valves, high and low pressure: OPEN / CLOSED, how far (%), the engine unit's target; the share of exhaust let back in, air mass per stroke against its target; rail pressure and boost against their targets; the injectors' quantity corrections (fuel balancing, mg/stroke, meaningful at warm idle). |
| **Details** | Every value read: its name, identifier, value and the reply's bytes, or why it has none (*reading...*, *not on this car*, *no answer*, *refused now*). |

Settings: flash the ambient light when a regeneration starts and ends (amber, then green or red; needs Ambient config
with its flash alerts on), km or miles, °C or °F, theme, layout, renderer, demo.

## Regenerations

**Running or not.** The SGBDs have no value table for the regeneration flags, and the EDIABAS job that combines them
(`STATUS_REGENERATION_CSF`) uses a dynamically defined identifier (service `2C`), which a read-only app may not use.
So the app decides by, in this order:

1. **The engine unit's after-treatment status** (DDE 8.3 only, `5372`, the shape of OBD PID 8B: bit 0 = regenerating),
   once it has been seen at 0 too (a flag stuck at 1 is no flag).
2. **The heat** before the filter (`44EF`, else the sensor value `4502`): 500 °C or more for 30 s starts one,
   under 420 °C for 30 s ends it. Driving alone doesn't get the filter's inlet that hot on these engines; a
   regeneration runs at about 600 °C.

**Done or stopped.** A regeneration is *done* when the distance since the last successful one (`44BF`) starts again
from 0, which is BMW's own marker of a successful regeneration; if that hasn't happened within 3 minutes of its end
(or the engine was switched off), it counts as *stopped early*.

**The regeneration point** (the mark on the soot bar) is, in this order: the soot against the engine unit's own load
(DDE 8.3, `5371`: 0 % after a regeneration, 100 % = due), its average soot at a regeneration's start (`4B52`), the
median of the starts the app has logged, or 24 g (typical for a B47 / B57; shown as *typical*).

**Due:** the load at 100 %, or the engine unit's regeneration request (`44BB`, again only once seen at 0).

**In the background** (`app.json` `autostart`): while the engine runs (rpm from the car's signal, not a request) the
filter's values are read every 20 s, every 5 s during a regeneration; nothing at all once the car is locked and left
(`VehicleCondition`), so the car can sleep. The log (`data/diesel.json`: the last 30 regenerations and the soot over the
last 1,000 km) is written every minute and at each regeneration's start and end. An app installed by hand
(`deploy-car.sh`) isn't started with the head unit: it then follows regenerations from its first opening on.

## What it reads

The engine unit tells its SGBD by its SGBD index (`22 F1 50`):

| Family | SGBD | Indexes | Layouts |
|---|---|---|---|
| DDE 8.3 | `D83BX7C0` (G-series B47 / B57) | `0F1FE8` `0F1FF0` `0F1FF4` `0F1FF8` `0F2670` `0F2674` `0F2678` `0F267C` | as in the SGBD |
| DDE 7 | `D75BX7A0`, `D70BX7A0` (F-series B47 / N47 / N57) | `0F1F70` `0F1F80` `0F1F90` `0F1FA0` | the filter's the same; EGR and injectors their own; no `53xx` / `4B5x` |
| DDE 9 | `D94BX7A0` (2020+ mild hybrids) | `0F2C80` | no public SGBD: read like DDE 8.3, marked **UNVERIFIED** |

An engine unit whose index isn't here is read like DDE 8.3 (UNVERIFIED) when the car's engine type says diesel or it
answers soot and the distance since the last regeneration plausibly; a petrol one is left alone.

| Value | DDE 8.3 | DDE 7 | Scaling |
|---|---|---|---|
| Soot (the regeneration coordinator's) | `44BE` | `44BE` | u16 × 0.01525902 g |
| Soot measured (pressure drop) / model | `44B9` / `44C1` | same | u16 × 0.01 g |
| Ash | `44BD` | same | u16 × 0.01525902 g |
| Pressure drop across the filter | `44ED` | same | u16 × 0.04577707 − 1000 hPa |
| Before the filter (corrected / sensor), before the oxidation catalyst | `44EF` / `4502`, `44F2` | same | u16 × 0.03128099 − 50 °C |
| Distance / engine time / fuel since the last successful regeneration | `44BF` / `44B7` / `44BC` | same | u32 m / u32 s / u16 × 0.01 l |
| Successful regenerations, average distance between | `44B8`, `44C7` | same | u16, u16 km |
| Odometer at the last five successful ones | `44D1`-`44D5` | same | u32 m |
| Filter life left | `4C78` | same | u16 × 10 km |
| Regeneration request / lock / interrupted (no value tables) | `44BB` / `44C2` / `44C0` | same | raw |
| After-treatment status (PID 8B: bit 0 regenerating, bit 1 active) | `5372` | — | u8 |
| Load against the regeneration point | `5371` | — | (u16 − 32767) × 100 / 255 % |
| Average soot at a regeneration's start / end | `4B52` / `4B53` | — | u16 × 0.01 − 327.67 g |
| AdBlue range, NOx before / after the SCR, SCR catalyst, before it, average conversion | `4692`, `450A` / `4508`, `532E`, `5308`, `4DF7` | same | km × 0.15259022, ppm × 0.03204395 − 100, °C × 0.03128099 − 50, × 0.001 |
| AdBlue quality, in the tank as the DDE receives it | `469C`, `4693` | — | u8 × 0.2 %, u16 × 0.5 g (unverified: the level's fallback) |
| EGR high pressure: position / target | `4D8C` / `4D8A` | `4C97` / `4C93` | DDE 8: u16 × 0.01220703 − 399.98779297 %; DDE 7: u16 × 0.004578 − 100 % |
| EGR low pressure: position / target | `4D3B` / `4D39` | `4C73` / — | as above (DDE 7 has only a duty cycle as target) |
| EGR rate, air mass per stroke / target | `4D88`, `47DD` / `4872` | same | × 0.01 %, × 0.03891051 / × 0.03051804 mg |
| Rail pressure / target | `4748` / `4715` | same | × 0.04577707 bar |
| Boost / target (absolute), ambient | `4841` / `42C8`, `4CF0` | same | × 0.15259022 / × 0.09155413 / × 0.03051804 hPa |
| Injector quantity corrections 1-6 | `5570`-`5575` | same | DDE 8: × 0.01 − 327.67; DDE 7: × 0.003052 − 100 mg/stroke |

The AdBlue unit: tank level `E439` (SCR04, index `0F2940`) or `D4D1` (SCR03, `0F22B0`), u16 × 0.00097656 l.

The injector corrections follow the engine unit's own numbering (the SGBD names them cylinders 1-6; the Bosch
labels count them in firing order); a B47 shows four (the fifth and sixth read 0).

**Pacing:** one request at a time, 120 ms apart; each identifier is first read alone, and once its reply length is
known, up to 8 go in one request. Live values every 1-2 s while their page is shown, the rest every 30 s. A refusal
(`7F 22 31`) carries no identifier and every app on the head unit gets every reply, so an identifier counts as *not on
this car* only after three refusals of its own single reads (and is asked again after a while).

## Not in it

- Starting a regeneration, resetting the filter's adaptation after a replacement, or anything else that writes: the
  three SGBDs have no routine (`31`) for a forced regeneration, and the app stays read-only.
- The DPF's fault codes: use the Fault Scanner.
- A petrol particulate filter (B48 / B58 OPF): Live Data and Service read its soot.

## Tests

`node kit/tools/test_diesel.js` (Node 8 compatible): the identifier table against BMW's SGBD index, the scalings, the
reader against a stand-in engine unit, the regeneration tracker, the demo and every page drawn.

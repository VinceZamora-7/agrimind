# Orange Pi One PIR Wiring

| PIR pin | Orange Pi connection |
| --- | --- |
| VCC | Physical pin 2 or 4 (5V) |
| GND | Physical pin 6 (GND) |
| OUT | Physical pin 7 (PA6) |

Physical pin 7 maps to `gpiochip0` line 6.

Test the input on the Orange Pi:

```sh
sudo gpioget --chip gpiochip0 --numeric 6
```

`0` means no motion and `1` means motion detected.

The installed libgpiod 2.x command requires `--chip`; the older positional form `gpioget gpiochip0 6` is not valid on this device. Currently `/dev/gpiochip0` is owned by root with mode `0600`, so the `orangepi` user needs a GPIO udev/group rule or the diagnostic must be launched with `sudo`.

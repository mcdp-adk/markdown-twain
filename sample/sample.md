# How Far Can a Lighthouse Be Seen?

A lighthouse is only useful if sailors can see it before they reach the rocks it guards. Two things decide how far away its light shows: how bright the lamp is, and how high it stands above the sea. This note looks at the second one, because it comes down to a little geometry that anyone can work out on paper.

The short answer is that height matters more than most people expect. The long answer is in [Seeing past the horizon](#seeing-past-the-horizon), further down this page.

## Why the horizon limits the view

The Earth is round, so the sea curves away from any observer. Past a certain distance, the water itself blocks the line of sight, no matter how clear the air is. That distance is the horizon, and it grows as the observer climbs higher.

A lighthouse has its own horizon, and so does the sailor on deck. The light becomes visible when the two horizons touch, which is why a keeper would write down both heights when describing the range of a light.

### Seeing past the horizon

For an observer at height $h$ above the sea, on a planet of radius $R$, the distance to the horizon is close to $d \approx \sqrt{2Rh}$, as long as $h$ is small compared with $R$. The range of a light is the sum of the lamp's horizon and the sailor's horizon:

$$
D = \sqrt{2Rh_1} + \sqrt{2Rh_2}
$$

Here $h_1$ is the height of the lamp and $h_2$ is the height of the sailor's eye. Light bends slightly as it passes through the air, so real ranges are a few percent longer than this formula gives.

## Working it out

The formula is easy to turn into code. The function below takes both heights in metres and returns the range in kilometres:

```python
from math import sqrt

EARTH_RADIUS_KM = 6371

def light_range_km(lamp_m: float, eye_m: float) -> float:
    lamp_km = lamp_m / 1000
    eye_km = eye_m / 1000
    return sqrt(2 * EARTH_RADIUS_KM * lamp_km) + sqrt(2 * EARTH_RADIUS_KM * eye_km)
```

Calling `light_range_km(50, 5)` gives about 33 kilometres. The table shows a few more cases, all for a sailor whose eye is 5 metres above the water.

| Lamp height | Lamp horizon | Total range |
| --- | ---: | ---: |
| 10 m | 11.3 km | 19.3 km |
| 25 m | 17.8 km | 25.8 km |
| 50 m | 25.2 km | 33.2 km |
| 100 m | 35.7 km | 43.7 km |

Doubling the height of a tower does not double its range. Because of the square root, a tower has to be four times as tall to be seen twice as far.

## What keepers had to know

Old light lists gave each light's height, colour, and pattern of flashes. A navigator checked three things before trusting a light:

- its colour;
- its flash pattern;
- its charted range.

Building a taller tower was not always the best way to extend a light's reach. Engineers weighed several options:

1. Raise the lamp, which extends the geometric range but costs a great deal of stone.

2. Use a stronger lamp, which helps in haze but cannot beat the curve of the Earth.

3. Build the tower on a cliff, which gives height almost for free, although cliff-top lights are often hidden by low cloud.

> A light that is too high is lost in the clouds, and a light that is too low is lost behind the waves. The keeper's art was finding the height between the two.

世界上许多灯塔都建在海岬或岛屿的高处，这样即使塔身不高，灯光也能照得很远。不过，建得太高的灯塔常常被低云遮住，因此工程师需要在高度和可见度之间取得平衡。

## Further reading

The geometry of the horizon is covered in more detail in the [Wikipedia article on the horizon](https://en.wikipedia.org/wiki/Horizon). For the history of how lights were catalogued, the [Wikipedia article on the List of Lights](https://en.wikipedia.org/wiki/List_of_lights) is a good place to start.

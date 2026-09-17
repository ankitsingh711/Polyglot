import { appConfig } from '../../core/config.js';
import { registerTool, type Tool, type ToolExecutionContext } from './registry.js';

/**
 * get_weather, backed by Open-Meteo (real public API, no key, no attribution
 * requirement, generous free tier). Two calls: geocode the place name, then
 * fetch the forecast for those coordinates.
 *
 * The security-relevant part is that the model chooses the INPUT, not the URL.
 * Endpoints come from config and only typed, range-checked values are ever
 * interpolated -- a tool that let a model influence the request URL is an SSRF
 * primitive with extra steps.
 */

const WMO_CODES: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow', 73: 'moderate snow', 75: 'heavy snow', 77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

interface GeocodeResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
  timezone?: string;
}

async function fetchJson(url: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { signal: combined, headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`weather service returned HTTP ${res.status}`);
  return res.json();
}

async function geocode(location: string, timeoutMs: number, signal?: AbortSignal): Promise<GeocodeResult | undefined> {
  const cfg = appConfig().tools.weather;
  const url = new URL(cfg.geocodeUrl);
  url.searchParams.set('name', location);
  url.searchParams.set('count', '1');
  url.searchParams.set('language', 'en');
  url.searchParams.set('format', 'json');

  const json = (await fetchJson(url.toString(), timeoutMs, signal)) as { results?: GeocodeResult[] };
  return json.results?.[0];
}

const weather: Tool = {
  name: 'get_weather',
  description:
    'Get the current weather and a short forecast for a place. Returns temperature, apparent temperature, ' +
    'humidity, wind, precipitation and conditions, plus today and tomorrow high/low. ' +
    'Use this whenever the user asks about weather; do not answer from memory.',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'City or place name, optionally with region or country, e.g. "Bengaluru" or "Springfield, Illinois".',
      },
      units: {
        type: 'string',
        enum: ['celsius', 'fahrenheit'],
        description: 'Temperature units. Defaults to celsius.',
      },
    },
    required: ['location'],
  },

  async execute(input, ctx: ToolExecutionContext) {
    const cfg = appConfig().tools.weather;
    const location = typeof input.location === 'string' ? input.location.trim().slice(0, 120) : '';
    const units = input.units === 'fahrenheit' ? 'fahrenheit' : 'celsius';

    if (!location) return { content: 'get_weather requires a "location".', isError: true };

    try {
      const place = await geocode(location, cfg.timeoutMs, ctx.signal);
      if (!place) {
        return { content: `No place called "${location}" was found. Try adding a country or region.`, isError: true };
      }

      const url = new URL(cfg.forecastUrl);
      // Coordinates come from OUR geocoder, not from the model.
      url.searchParams.set('latitude', String(place.latitude));
      url.searchParams.set('longitude', String(place.longitude));
      url.searchParams.set(
        'current',
        'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      );
      url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code');
      url.searchParams.set('forecast_days', '2');
      url.searchParams.set('timezone', 'auto');
      url.searchParams.set('temperature_unit', units);
      url.searchParams.set('wind_speed_unit', units === 'fahrenheit' ? 'mph' : 'kmh');

      const json = (await fetchJson(url.toString(), cfg.timeoutMs, ctx.signal)) as {
        current?: Record<string, number>;
        daily?: Record<string, Array<number | string>>;
      };

      const current = json.current ?? {};
      const daily = json.daily ?? {};
      const symbol = units === 'fahrenheit' ? 'F' : 'C';

      const payload = {
        location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        current: {
          conditions: WMO_CODES[Number(current.weather_code)] ?? 'unknown',
          temperature: `${current.temperature_2m}${symbol}`,
          feels_like: `${current.apparent_temperature}${symbol}`,
          humidity: `${current.relative_humidity_2m}%`,
          precipitation: `${current.precipitation} mm`,
          wind: `${current.wind_speed_10m} ${units === 'fahrenheit' ? 'mph' : 'km/h'}`,
        },
        forecast: (daily.time ?? []).map((date, i) => ({
          date,
          high: `${daily.temperature_2m_max?.[i]}${symbol}`,
          low: `${daily.temperature_2m_min?.[i]}${symbol}`,
          precipitation_chance: `${daily.precipitation_probability_max?.[i] ?? 0}%`,
          conditions: WMO_CODES[Number(daily.weather_code?.[i])] ?? 'unknown',
        })),
        source: 'open-meteo.com',
      };

      return { content: JSON.stringify(payload) };
    } catch (err) {
      const message = (err as Error).name === 'TimeoutError'
        ? 'the weather service did not respond in time'
        : (err as Error).message;
      return { content: `Could not fetch weather for "${location}": ${message}.`, isError: true };
    }
  },
};

registerTool(weather);

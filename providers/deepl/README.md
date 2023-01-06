# DeepL provider for Strapi Translate Plugin

Configure the provider through the pluginOptions:

```js
module.exports = {
  // ...
  translate: {
    enabled: true,
    config: {
      // Choose one of the available providers
      provider: 'deepl',
      // Pass credentials and other options to the provider
      providerOptions: {
        // your API key - required and wil cause errors if not provided
        apiKey: 'key',
        // use custom api url - optional
        apiUrl: 'https://api-free.deepl.com',
      },
      // other options ...
    },
  },
  // ...
}
```

or use the default environment variables:

- `DEEPL_API_KEY` - default `undefined`
- `DEEPL_API_URL` - default `undefined`

To get an API key, register for free at [www.deepl.com/pro#developer](https://www.deepl.com/pro#developer).

## Limitations:

- Only the [deepl supported languages](https://www.deepl.com/docs-api/translating-text/request/) can be translated
- The API-Limits of DeepL ([size](https://www.deepl.com/de/docs-api/accessing-the-api/limits/), [number of fields](https://www.deepl.com/de/docs-api/translating-text/request/)) and [too many requests](https://www.deepl.com/de/docs-api/api-access/error-handling/) should be respected. If one field is larger than the request size limit, the content needs to be split and merged at some character, which may break the content layout!
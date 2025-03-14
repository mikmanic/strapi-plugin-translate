'use strict'

const deepl = require('deepl-node')
const Bottleneck = require('bottleneck/es5')

const {
  DEEPL_PRIORITY_DEFAULT,
  DEEPL_API_MAX_TEXTS,
  DEEPL_API_ROUGH_MAX_REQUEST_SIZE,
  DEEPL_APP_INFO
} = require('./constants')
const { parseLocale } = require('./parse-locale')
const { getService } = require('./get-service')

/**
 * Module dependencies
 */

module.exports = {
  provider: 'deepl',
  name: 'DeepL',

  init(providerOptions = {}) {
    const apiKey = process.env.DEEPL_API_KEY || providerOptions.apiKey
    const apiUrl = process.env.DEEPL_API_URL || providerOptions.apiUrl
    const localeMap =
      typeof providerOptions.localeMap === 'object'
        ? providerOptions.localeMap
        : {}
    const apiOptions =
      typeof providerOptions.apiOptions === 'object'
        ? providerOptions.apiOptions
        : {}
    const glossaries =
      Array.isArray(providerOptions.glossaries)
        ? providerOptions.glossaries
        : []

    const client = new deepl.Translator(apiKey, {
      serverUrl: apiUrl,
      appInfo: DEEPL_APP_INFO
    })

    const limiter = new Bottleneck({
      minTime: process.env.NODE_ENV == 'test' ? 10 : 200,
      maxConcurrent: 5,
    })

    const rateLimitedTranslate = limiter.wrap(client.translateText.bind(client))

    return {
      /**
       * @param {{
       *  text:string|string[]|any[],
       *  sourceLocale: string,
       *  targetLocale: string,
       *  priority: number,
       *  format?: 'plain'|'markdown'|'html'
       * }} options all translate options
       * @returns {string[]} the input text(s) translated
       */
      async translate({ text, priority, sourceLocale, targetLocale, format }) {
        if (!text) {
          return []
        }
        if (!sourceLocale || !targetLocale) {
          throw new Error('source and target locale must be defined')
        }

        const chunksService = getService('chunks')
        const formatService = getService('format')

        const tagHandling = format === 'plain' ? undefined : 'html'

        let input = text
        if (format === 'jsonb') {
          input = await formatService.blockToHtml(input)
        } else if (format === 'markdown') {
          input = formatService.markdownToHtml(input)
        }

        let textArray = Array.isArray(input) ? input : [input]

        const { chunks, reduceFunction } = chunksService.split(textArray, {
          maxLength: DEEPL_API_MAX_TEXTS,
          maxByteSize: DEEPL_API_ROUGH_MAX_REQUEST_SIZE,
        })

        const parsedSourceLocale = parseLocale(sourceLocale, localeMap, 'source')
        const parsedTargetLocale = parseLocale(targetLocale, localeMap, 'target')

        const glossary = glossaries.find(
          (g) => g.target_lang === parsedTargetLocale && g.source_lang === parsedSourceLocale
        )?.id

        if (apiOptions.glossary) {
          console.warn('Glossary provided in apiOptions will be ignored and overwritten by the actual glossary that should be used for this translation.')
        }

        const result = reduceFunction(
          await Promise.all(
            chunks.map(async (texts) => {
              const result = await rateLimitedTranslate.withOptions(
                {
                  priority:
                    typeof priority == 'number'
                      ? priority
                      : DEEPL_PRIORITY_DEFAULT,
                },
                texts,
                parsedSourceLocale,
                parsedTargetLocale,
                { ...apiOptions, tagHandling, glossary }
              )
              return result.map((value) => value.text)
            })
          )
        )
        
        if (format === 'jsonb') {
          return formatService.htmlToBlock(result)
        }
        if (format === 'markdown') {
          return formatService.htmlToMarkdown(result)
        }

        return result
      },
      async usage() {
        return (await client.getUsage()).character
      },
    }
  },
}

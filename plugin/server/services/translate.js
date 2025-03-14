'use strict'

const get = require('lodash/get')
const set = require('lodash/set')
const groupBy = require('lodash/groupBy')

const { getService } = require('../utils/get-service')
const { getAllTranslatableFields } = require('../utils/translatable-fields')
const { TRANSLATE_PRIORITY_BATCH_TRANSLATION } = require('../utils/constants')
const { removeUids } = require('../utils/remove-uids')
const { BatchTranslateManager } = require('./batch-translate')
const {TRANSLATE_PRIORITY_DIRECT_TRANSLATION} = require("../utils/constants");
const {translateRelations} = require("../utils/translate-relations");
const {updateUids} = require("../utils/update-uids");
const {filterAllDeletedFields} = require("../utils/delete-fields");
const {cleanData} = require("../utils/clean-data");

module.exports = ({ strapi }) => ({
  batchTranslateManager: new BatchTranslateManager(),

  async estimateUsage({ data, fieldsToTranslate }) {
    const text = fieldsToTranslate
      .map(({ field }) => get(data, field, ''))
      .join('')

    return text.length
  },

  async translate({
    data,
    sourceLocale,
    targetLocale,
    fieldsToTranslate,
    priority,
  }) {
    // Do not translate if there is nothing to do (for language variants)
    if (sourceLocale === targetLocale) {
      return data
    }

    const groupedFields = groupBy(fieldsToTranslate, 'format')

    const translatedData = { ...data }
    await Promise.all(
      Object.keys(groupedFields).map(async (format) => {
        const textsToTranslate = groupedFields[format].map(({ field }) =>
          get(data, field, '')
        )

        if (textsToTranslate.length === 0) {
          return
        }

        const translateResult = await strapi
          .plugin('translate')
          .provider.translate({
            text: textsToTranslate,
            targetLocale,
            sourceLocale,
            priority,
            format,
          })

        groupedFields[format].forEach(({ field }, index) => {
          set(translatedData, field, translateResult[index])
        })
      })
    )

    return translatedData
  },

  async batchTranslate(params) {
    return this.batchTranslateManager.submitJob(params)
  },
  async batchTranslatePauseJob(id) {
    return this.batchTranslateManager.pauseJob(id)
  },
  async batchTranslateResumeJob(id) {
    return this.batchTranslateManager.resumeJob(id)
  },
  async batchTranslateCancelJob(id) {
    return this.batchTranslateManager.cancelJob(id)
  },
  async batchUpdate(params) {
    const { updatedEntryIDs, sourceLocale } = params
    for (const updateID of updatedEntryIDs) {
      const update = await strapi
        .service('plugin::translate.updated-entry')
        .findOne(updateID)

      if (!update) continue
      const mainID = Number(update.groupID.split('-')[0])

      const entity = await strapi.db.query(update.contentType).findOne({
        where: { id: mainID },
        populate: { localizations: true },
      })

      const normalizedEntities = [entity, ...entity.localizations]

      normalizedEntities.forEach((normalizedEntity) => {
        delete normalizedEntity.localizations
      })

      const sourceEntity = normalizedEntities.find(
        ({ locale }) => locale === sourceLocale
      )

      if (!sourceEntity)
        throw new Error('No entity found with locale ' + sourceLocale)

      const targets = normalizedEntities
        .map(({ locale, id }) => ({ id, locale }))
        .filter(({ locale }) => locale !== sourceLocale)

      const contentTypeSchema = strapi.contentTypes[update.contentType]
      const fieldsToTranslate = await getAllTranslatableFields(
        sourceEntity,
        contentTypeSchema
      )

      for (const { locale, id } of targets) {
        const translated = await this.translate({
          sourceLocale,
          targetLocale: locale,
          priority: TRANSLATE_PRIORITY_BATCH_TRANSLATION,
          fieldsToTranslate,
          data: sourceEntity,
        })

        const uidsUpdated = strapi.config.get('plugin.translate').regenerateUids
          ? await updateUids(translated, update.contentType)
          : removeUids(translated, update.contentType)

        const withFieldsDeleted = filterAllDeletedFields(
          uidsUpdated,
          update.contentType
        )

        const fullyTranslatedData = cleanData(
          withFieldsDeleted,
          contentTypeSchema
        )

        delete fullyTranslatedData.locale

        strapi.db.query(update.contentType).update({
          where: { id },
          data: fullyTranslatedData,
        })
      }
      await strapi.service('plugin::translate.updated-entry').delete(updateID)
    }
  },
  async contentTypes() {
    const localizedContentTypes = Object.keys(strapi.contentTypes).filter(
      (ct) => strapi.contentTypes[ct].pluginOptions?.i18n?.localized
    )

    const locales = await strapi.service('plugin::i18n.locales').find()

    const reports = await Promise.all(
      localizedContentTypes.map(async (contentType) => {
        // get jobs
        const translateJobs = await strapi.db
          .query('plugin::translate.batch-translate-job')
          .findMany({
            where: { contentType: { $eq: contentType } },
            orderBy: { updatedAt: 'desc' },
          })

        // calculate current translation statuses
        const info = await Promise.all(
          locales.map(async ({ code }) => {
            const countPromise = strapi.db
              .query(contentType)
              .count({ where: { locale: code } })

            const complete = await getService('untranslated').isFullyTranslated(
              contentType,
              code
            )

            return {
              count: await countPromise,
              complete,
            }
          })
        )

        // create report
        const localeReports = {}
        locales.forEach(({ code }, index) => {
          localeReports[code] = {
            ...info[index],
            job: translateJobs.find((job) => job.targetLocale === code),
          }
        })
        return {
          contentType,
          collection: strapi.contentTypes[contentType].info.displayName,
          localeReports,
        }
      })
    )

    return { contentTypes: reports, locales }
  },
  async translateOtherLocales({ sourceEntry, fieldsToTranslate, contentTypeUid }) {
    // Get the locale service from the i18n plugin
    const localeService = strapi.plugin('i18n').service('locales')

    // Fetch all locales
    let locales = await localeService.find()

    // remove source locale from locales
    locales = locales.filter(locale => locale.code !== sourceEntry.locale)

    for (const locale of locales) {
      const targetLocale = locale.code;

      const translatedData = await getService('translate').translate({
        data: sourceEntry,
        sourceLocale: sourceEntry.locale,
        targetLocale,
        fieldsToTranslate,
        priority: TRANSLATE_PRIORITY_DIRECT_TRANSLATION,
      })

      const existingLocalization = sourceEntry.localizations.find(l => l.locale === targetLocale);

      if (existingLocalization) {
        // Update the existing localization
        const data = fieldsToTranslate.reduce((acc, field) => {
          acc[field.field] = translatedData[field.field];
          return acc;
        }, {})

        strapi.log.debug(`Updating ${targetLocale} localization for ${contentTypeUid} id: ${existingLocalization.id}`)

        await strapi.entityService.update(
          contentTypeUid,
          existingLocalization.id,
          {
            data,
          }
        )
      } else {
        // Create a new localization
        const contentSchema = strapi.contentTypes[contentTypeUid]

        const withRelations = await translateRelations(
          translatedData,
          contentSchema,
          targetLocale
        )

        const uidsUpdated = await updateUids(
          withRelations,
          contentTypeUid
        )

        const withFieldsDeleted = filterAllDeletedFields(
          uidsUpdated,
          contentTypeUid
        )

        const newLocaleData = cleanData(
          withFieldsDeleted,
          contentSchema
        )

        // Localizations will be synced after creating the new localization
        // newLocaleData.localizations = newLocalizations
        newLocaleData.locale = targetLocale
        newLocaleData.publishedAt = new Date()

        strapi.log.debug(`Creating ${targetLocale} localization for ${contentTypeUid} with id: ${sourceEntry.id}`)

        // Create localized entry
        const l = await strapi.entityService.create(contentTypeUid, {
          data: newLocaleData,
          // Needed for syncing localizations
          populate: ['localizations'],
        })

        // update main entry with new localization
        sourceEntry.localizations.push({
          id: l.id,
          locale: l.locale
        })

        await strapi.query(contentTypeUid).update({
          where: { id: sourceEntry.id },
          data: {
            localizations: sourceEntry.localizations.map(({ id }) => id)
          },
          populate: ['localizations']
        })

        // sync localizations
        await strapi.plugin('i18n').service('localizations')
          .syncLocalizations(
            sourceEntry,
            { model: strapi.getModel(contentTypeUid) }
          );

        // update  Non Localized Attributes in all localizations
        await strapi.plugin('i18n').service('localizations')
          .syncNonLocalizedAttributes(
            sourceEntry,
            { model: strapi.getModel(contentTypeUid) }
          );
      }
    }
  }
})

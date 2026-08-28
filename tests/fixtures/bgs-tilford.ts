/**
 * Verbatim BGS WMS GetFeatureInfo responses for Tilford (BNG E487125 N143839),
 * captured by scripts/probe.mjs. Not edited, not invented.
 */

export const TILFORD_BEDROCK_XML = `<?xml version="1.0" encoding="UTF-8"?>

<FeatureInfoResponse xmlns:esri_wms="http://www.esri.com/wms" xmlns="http://www.esri.com/wms">
<FIELDS OBJECTID="402933" Shape="Polygon" LEX="FO" LEX_RCS_I="12102299_FO-SDST" LEX_RCS_D="Folkestone Formation-Sandstone" MAX_TIME_D="Aptian Age" MIN_TIME_D="Albian Age" BGSREF="953" VERSION="3.25" RELEASED="31-03-2025" NOM_BGS_YR="Not Entered" LEX_RCS="FO-SDST" MAX_PERIOD="Cretaceous" MIN_PERIOD="Cretaceous" TYPE_D="sedimentary bedrock" BROAD_D=" " SETTING_D="shallow seas" LEX_WEB="https://webapps.bgs.ac.uk/lexicon/lexicon.cfm?pub=FO" LEX_D="Folkestone Formation" RCS="SDST" RCS_X="SDST" RCS_D="Sandstone" RCS_ORIGIN="Sedimentary" RANK="Formation" BED_EQ_D="Not Applicable" MB_EQ_D="Not Applicable" FM_EQ_D="Folkestone Formation" SUBGP_EQ_D="No Parent" GP_EQ_D="Lower Greensand Group" SUPGP_EQ_D="No Parent" MAX_AGE="Aptian" MAX_EPOCH="Early Cretaceous" MAX_SUBPER="Not Defined" MAX_ERA="Mesozoic" MAX_EON="Phanerozoic" BGSTYPE="Bedrock" SET_PLUS_D=" " ENVIRONM_D="These sedimentary rocks are shallow-marine in origin. They are detrital, ranging from coarse- to fine-grained (locally with some carbonate content) forming interbedded sequences." BGSRED="148" BGSGREEN="201" BGSBLUE="0" MAP_SRC="SU84SE" NOM_SCALE="10000"></FIELDS>
</FeatureInfoResponse>`;

export const TILFORD_SUPERFICIAL_XML = `<?xml version="1.0" encoding="UTF-8"?>

<FeatureInfoResponse xmlns:esri_wms="http://www.esri.com/wms" xmlns="http://www.esri.com/wms">
<FIELDS OBJECTID="203618" Shape="Polygon" LEX="ALV" LEX_RCS_I="11199999_ALV-XCZSV" LEX_RCS_D="Alluvium-Clay, silt, sand and gravel" MAX_TIME_D="Quaternary Period" MIN_TIME_D="Quaternary Period" BGSREF="400" VERSION="3.25" RELEASED="31-03-2025" NOM_BGS_YR="Not Entered" LEX_RCS="ALV-XCZSV" MAX_PERIOD="Quaternary" MIN_PERIOD="Quaternary" TYPE_D="superficial deposits" BROAD_D="variable sediment of mud, sand and gravel with some peat in places" SETTING_D="rivers (U)" LEX_WEB="https://webapps.bgs.ac.uk/lexicon/lexicon.cfm?pub=ALV" LEX_D="Alluvium" RCS="XCZSV" RCS_X="C + S + V + Z" RCS_D="Clay, silt, sand and gravel" RCS_ORIGIN="Sedimentary" RANK="Litho-morpho-genetic" BED_EQ_D="Not Applicable" GP_EQ_D="No Parent" BGSTYPE="Superficial" NOM_SCALE="10000"></FIELDS>
</FeatureInfoResponse>`;

/** What the service returns where there is genuinely nothing - 159 bytes. */
export const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>

<FeatureInfoResponse xmlns:esri_wms="http://www.esri.com/wms" xmlns="http://www.esri.com/wms">
</FeatureInfoResponse>`;

import { fetch } from "undici";
import { Innertube, Session } from "youtubei.js";

import { env } from "../../config.js";
import { cleanString } from "../../misc/utils.js";
import { getCookie, updateCookieValues } from "../cookie/manager.js";

const PLAYER_REFRESH_PERIOD = 1000 * 60 * 15; // ms

let innertube, lastRefreshedAt;

const codecList = {
    h264: {
        videoCodec: "avc1",
        audioCodec: "mp4a",
        container: "mp4"
    },
    av1: {
        videoCodec: "av01",
        audioCodec: "opus",
        container: "webm"
    },
    vp9: {
        videoCodec: "vp9",
        audioCodec: "opus",
        container: "webm"
    }
}

const transformSessionData = (cookie) => {
    if (!cookie)
        return;

    const values = { ...cookie.values() };
    const REQUIRED_VALUES = [ 'access_token', 'refresh_token' ];

    if (REQUIRED_VALUES.some(x => typeof values[x] !== 'string')) {
        return;
    }

    if (values.expires) {
        values.expiry_date = values.expires;
        delete values.expires;
    } else if (!values.expiry_date) {
        return;
    }

    return values;
}

const cloneInnertube = async (customFetch) => {
    const shouldRefreshPlayer = lastRefreshedAt + PLAYER_REFRESH_PERIOD < new Date();
    if (!innertube || shouldRefreshPlayer) {
        innertube = await Innertube.create({
            fetch: customFetch
        });
        lastRefreshedAt = +new Date();
    }

    const session = new Session(
        innertube.session.context,
        innertube.session.key,
        innertube.session.api_version,
        innertube.session.account_index,
        innertube.session.player,
        undefined,
        customFetch ?? innertube.session.http.fetch,
        innertube.session.cache
    );

    const cookie = getCookie('youtube_oauth');
    const oauthData = transformSessionData(cookie);

    if (!session.logged_in && oauthData) {
        await session.oauth.init(oauthData);
        session.logged_in = true;
    }

    if (session.logged_in) {
        if (session.oauth.shouldRefreshToken()) {
            await session.oauth.refreshAccessToken();
        }

        const cookieValues = cookie.values();
        const oldExpiry = new Date(cookieValues.expiry_date);
        const newExpiry = new Date(session.oauth.oauth2_tokens.expiry_date);

        if (oldExpiry.getTime() !== newExpiry.getTime()) {
            updateCookieValues(cookie, {
                ...session.oauth.client_id,
                ...session.oauth.oauth2_tokens,
                expiry_date: newExpiry.toISOString()
            });
        }
    }

    const yt = new Innertube(session);
    return yt;
}

export default async function(o) {
    let yt;
    try {
        yt = await cloneInnertube(
            (input, init) => fetch(input, {
                ...init,
                dispatcher: o.dispatcher
            })
        );
    } catch(e) {
        if (e.message?.endsWith("decipher algorithm")) {
            return { error: "youtube.decipher" }
        } else if (e.message?.includes("refresh access token")) {
            return { error: "youtube.token_expired" }
        } else throw e;
    }

    let info;
    try {
        info = await yt.getBasicInfo(o.id, yt.session.logged_in ? 'ANDROID' : 'IOS');
    } catch(e) {
        if (e?.info?.reason === "This video is private") {
            return { error: "content.video.private" };
        } else if (e?.message === "This video is unavailable") {
            return { error: "content.video.unavailable" };
        } else {
            return { error: "fetch.fail" };
        }
    }

    if (!info) return { error: "fetch.fail" };

    const playability = info.playability_status;
    const basicInfo = info.basic_info;

    switch(playability.status) {
        case "LOGIN_REQUIRED":
            if (playability.reason.endsWith("bot")) {
                return { error: "youtube.login" }
            }
            if (playability.reason.endsWith("age")) {
                return { error: "content.video.age" }
            }
            if (playability?.error_screen?.reason?.text === "Private video") {
                return { error: "content.video.private" }
            }
            break;

        case "UNPLAYABLE":
            if (playability?.reason?.endsWith("request limit.")) {
                return { error: "fetch.rate" }
            }
            if (playability?.error_screen?.subreason?.text?.endsWith("in your country")) {
                return { error: "content.video.region" }
            }
            if (playability?.error_screen?.reason?.text === "Private video") {
                return { error: "content.video.private" }
            }
            break;

        case "AGE_VERIFICATION_REQUIRED":
            return { error: "content.video.age" };
    }

    if (playability.status !== "OK") {
        return { error: "content.video.unavailable" };
    }

    if (basicInfo.is_live) {
        return { error: "content.video.live" };
    }

    if (basicInfo.duration > env.durationLimit) {
        return { error: "content.too_long" };
    }

    // return a critical error if returned video is "Video Not Available"
    // or a similar stub by youtube
    if (basicInfo.id !== o.id) {
        return {
            error: "fetch.fail",
            critical: true
        }
    }

    let format = o.format || "h264";

    const filterByCodec = (formats) =>
        formats.filter(e =>
            e.mime_type.includes(codecList[format].videoCodec)
            || e.mime_type.includes(codecList[format].audioCodec)
        ).sort((a, b) =>
            Number(b.bitrate) - Number(a.bitrate)
        );

    let adaptive_formats = filterByCodec(info.streaming_data.adaptive_formats);

    if (adaptive_formats.length === 0 && ["vp9", "av1"].includes(format)) {
        format = "h264";
        adaptive_formats = filterByCodec(info.streaming_data.adaptive_formats);
    }

    const bestVideo = adaptive_formats.find(i => i.has_video && i.content_length);
    const hasAudio = adaptive_formats.find(i => i.has_audio && i.content_length);

    if ((!bestVideo && !o.isAudioOnly) || (!hasAudio && o.isAudioOnly)) {
        return { error: "fetch.empty" };
    }

    const checkBestAudio = (i) => (i.has_audio && !i.has_video);

    let audio = adaptive_formats.find(i => checkBestAudio(i) && i.is_original);
    let isDubbed;

    if (o.dubLang) {
        let dubbedAudio = adaptive_formats.find(i =>
            checkBestAudio(i) && i.language === o.dubLang && i.audio_track
        )

        if (dubbedAudio && !dubbedAudio?.audio_track?.audio_is_default) {
            audio = dubbedAudio;
            isDubbed = true;
        }
    }

    if (!audio) {
        audio = adaptive_formats.find(i => checkBestAudio(i));
    }

    const fileMetadata = {
        title: cleanString(basicInfo.title.trim()),
        artist: cleanString(basicInfo.author.replace("- Topic", "").trim())
    }

    if (basicInfo?.short_description?.startsWith("Provided to YouTube by")) {
        const descItems = basicInfo.short_description.split("\n\n", 5);

        if (descItems.length === 5) {
            fileMetadata.album = descItems[2];
            fileMetadata.copyright = descItems[3];
            if (descItems[4].startsWith("Released on:")) {
                fileMetadata.date = descItems[4].replace("Released on: ", '').trim();
            }
        }
    }

    const filenameAttributes = {
        service: "youtube",
        id: o.id,
        title: fileMetadata.title,
        author: fileMetadata.artist,
        youtubeDubName: isDubbed ? o.dubLang : false
    }

    if (audio && o.isAudioOnly) return {
        type: "audio",
        isAudioOnly: true,
        urls: audio.url,
        startTime : o.startTime,
        endTime : o.endTime,
        filenameAttributes,
        fileMetadata,
        bestAudio: format === "h264" ? "m4a" : "opus",
    }

    const qual = (i) => {
        if (!i.quality_label) {
            return;
        }

        return i.quality_label.split('p', 2)[0].split('s', 2)[0]
    }

    const quality = o.quality === "max" ? "9000" : o.quality;
    const bestQuality = qual(bestVideo);
    const matchingQuality = Number(quality) > Number(bestQuality) ? bestQuality : quality;

    const video = adaptive_formats.find(i =>
        qual(i) === matchingQuality && i.has_video && !i.has_audio
    );

    if (video && audio) {
        filenameAttributes.qualityLabel = video.quality_label;
        filenameAttributes.resolution = `${video.width}x${video.height}`;
        filenameAttributes.extension = codecList[format].container;
        filenameAttributes.youtubeFormat = format;

        return {
            type: "merge",
            urls: [
                video.url,
                audio.url
            ],
            startTime : o.startTime,
            endTime : o.endTime,
            watermark : o.watermark,
            filenameAttributes,
            fileMetadata
        }
    }

    return { error: "fetch.fail" };
}

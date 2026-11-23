# Reproducible build environment for the camera APK and the web client.
#
# The camera app needs JDK 8 (Android Gradle plugin 2.1.x fails on JDK 9+), the
# Android 2.3.3 platform (API 10) and build-tools 25.0.2. The web client needs
# Node.js 22. Every download is pinned to a version and verified by checksum, so the
# host only needs Docker. Used by scripts/build.sh.

FROM eclipse-temurin:8u512-b09-jdk-noble

ARG NODE_VERSION=22.23.5
ARG NODE_SHA256=c54118104acc524633b5abe106bbf44a53126ec8b4e5fa105cb92b5d7de8a1a1
# SHA-1 values come from Google's SDK repository manifest (repository2-3.xml).
ARG PLATFORM_ZIP=android-2.3.3_r02.zip
ARG PLATFORM_SHA1=887e37783ec32f541ea33c2c649dda648e8e6fb3
ARG BUILD_TOOLS_ZIP=build-tools_r25.0.2-linux.zip
ARG BUILD_TOOLS_SHA1=ff953c0177e317618fda40516f3e9d95fd43c7ae

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/node/bin:$PATH

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip gzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"; \
    echo "${NODE_SHA256}  node-v${NODE_VERSION}-linux-x64.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/node; \
    tar -xzf "node-v${NODE_VERSION}-linux-x64.tar.gz" -C /opt/node --strip-components=1; \
    rm "node-v${NODE_VERSION}-linux-x64.tar.gz"; \
    node --version

RUN set -eux; \
    cd /tmp; \
    curl -fsSLO "https://dl.google.com/android/repository/${PLATFORM_ZIP}"; \
    echo "${PLATFORM_SHA1}  ${PLATFORM_ZIP}" | sha1sum -c -; \
    curl -fsSLO "https://dl.google.com/android/repository/${BUILD_TOOLS_ZIP}"; \
    echo "${BUILD_TOOLS_SHA1}  ${BUILD_TOOLS_ZIP}" | sha1sum -c -; \
    mkdir -p "$ANDROID_HOME/platforms" "$ANDROID_HOME/build-tools" "$ANDROID_HOME/licenses"; \
    unzip -q "${PLATFORM_ZIP}" -d /tmp/platform; \
    mv /tmp/platform/* "$ANDROID_HOME/platforms/android-10"; \
    unzip -q "${BUILD_TOOLS_ZIP}" -d /tmp/build-tools; \
    mv /tmp/build-tools/* "$ANDROID_HOME/build-tools/25.0.2"; \
    rm -rf /tmp/*.zip /tmp/platform /tmp/build-tools; \
    # The zips carry owner-only directory modes; the build runs as the host user.
    chmod -R a+rX "$ANDROID_HOME"; \
    ls "$ANDROID_HOME/platforms/android-10/android.jar" "$ANDROID_HOME/build-tools/25.0.2/aapt"

# Gradle, npm and HOME point into /cache so a mounted volume keeps downloads between
# builds and the container can run as the host user (files in the checkout stay theirs).
ENV GRADLE_USER_HOME=/cache/gradle \
    npm_config_cache=/cache/npm \
    HOME=/cache/home

WORKDIR /src

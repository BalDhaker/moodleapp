// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Component, Optional, OnInit, OnDestroy, Output, EventEmitter } from '@angular/core';
import { IonContent } from '@ionic/angular';

import { CoreConstants } from '@/core/constants';
import { CoreSite } from '@classes/site';
import { CoreCourseModuleMainActivityComponent } from '@features/course/classes/main-activity-component';
import { CoreCourseContentsPage } from '@features/course/pages/contents/contents';
import { CoreH5PDisplayOptions } from '@features/h5p/classes/core';
import { CoreH5PHelper } from '@features/h5p/classes/helper';
import { CoreH5P } from '@features/h5p/services/h5p';
import { CoreXAPIOffline } from '@features/xapi/services/offline';
import { CoreXAPI } from '@features/xapi/services/xapi';
import { CoreNetwork } from '@services/network';
import { CoreFilepool } from '@services/filepool';
import { CoreNavigator } from '@services/navigator';
import { CoreSites } from '@services/sites';
import { CoreDomUtils } from '@services/utils/dom';
import { CoreWSFile } from '@services/ws';
import { CoreEventObserver, CoreEvents } from '@singletons/events';
import {
    AddonModH5PActivity,
    AddonModH5PActivityAccessInfo,
    AddonModH5PActivityData,
    AddonModH5PActivityProvider,
    AddonModH5PActivityXAPIData,
} from '../../services/h5pactivity';
import {
    AddonModH5PActivitySync,
    AddonModH5PActivitySyncProvider,
    AddonModH5PActivitySyncResult,
} from '../../services/h5pactivity-sync';
import { CoreFileHelper } from '@services/file-helper';
import { AddonModH5PActivityModuleHandlerService } from '../../services/handlers/module';

/**
 * Component that displays an H5P activity entry page.
 */
@Component({
    selector: 'addon-mod-h5pactivity-index',
    templateUrl: 'addon-mod-h5pactivity-index.html',
})
export class AddonModH5PActivityIndexComponent extends CoreCourseModuleMainActivityComponent implements OnInit, OnDestroy {

    @Output() onActivityFinish = new EventEmitter<boolean>();

    component = AddonModH5PActivityProvider.COMPONENT;
    moduleName = 'h5pactivity';

    h5pActivity?: AddonModH5PActivityData; // The H5P activity object.
    accessInfo?: AddonModH5PActivityAccessInfo; // Info about the user capabilities.
    deployedFile?: CoreWSFile; // The H5P deployed file.

    stateMessage?: string; // Message about the file state.
    downloading = false; // Whether the H5P file is being downloaded.
    needsDownload = false; // Whether the file needs to be downloaded.
    percentage?: string; // Download/unzip percentage.
    showPercentage = false; // Whether to show the percentage.
    progressMessage?: string; // Message about download/unzip.
    playing = false; // Whether the package is being played.
    displayOptions?: CoreH5PDisplayOptions; // Display options for the package.
    onlinePlayerUrl?: string; // URL to play the package in online.
    fileUrl?: string; // The fileUrl to use to play the package.
    state?: string; // State of the file.
    siteCanDownload = false;
    trackComponent?: string; // Component for tracking.
    hasOffline = false;
    isOpeningPage = false;
    canViewAllAttempts = false;

    protected fetchContentDefaultError = 'addon.mod_h5pactivity.errorgetactivity';
    protected syncEventName = AddonModH5PActivitySyncProvider.AUTO_SYNCED;
    protected site: CoreSite;
    protected observer?: CoreEventObserver;
    protected messageListenerFunction: (event: MessageEvent) => Promise<void>;
    protected checkCompletionAfterLog = false; // It's called later, when the user plays the package.

    constructor(
        protected content?: IonContent,
        @Optional() courseContentsPage?: CoreCourseContentsPage,
    ) {
        super('AddonModH5PActivityIndexComponent', content, courseContentsPage);

        this.site = CoreSites.getRequiredCurrentSite();
        this.siteCanDownload = this.site.canDownloadFiles() && !CoreH5P.isOfflineDisabledInSite();

        // Listen for messages from the iframe.
        this.messageListenerFunction = this.onIframeMessage.bind(this);
        window.addEventListener('message', this.messageListenerFunction);
    }

    /**
     * @inheritdoc
     */
    async ngOnInit(): Promise<void> {
        super.ngOnInit();

        this.loadContent();
    }

    /**
     * @inheritdoc
     */
    protected async fetchContent(refresh?: boolean, sync = false, showErrors = false): Promise<void> {
        this.h5pActivity = await AddonModH5PActivity.getH5PActivity(this.courseId, this.module.id, {
            siteId: this.siteId,
        });

        this.dataRetrieved.emit(this.h5pActivity);
        this.description = this.h5pActivity.intro;
        this.displayOptions = CoreH5PHelper.decodeDisplayOptions(this.h5pActivity.displayoptions);

        if (sync) {
            await this.syncActivity(showErrors);
        }

        await Promise.all([
            this.checkHasOffline(),
            this.fetchAccessInfo(),
            this.fetchDeployedFileData(),
        ]);

        this.trackComponent = this.accessInfo?.cansubmit ? AddonModH5PActivityProvider.TRACK_COMPONENT : '';
        this.canViewAllAttempts = !!this.h5pActivity.enabletracking && !!this.accessInfo?.canreviewattempts &&
                AddonModH5PActivity.canGetUsersAttemptsInSite();

        if (this.h5pActivity.package && this.h5pActivity.package[0]) {
            // The online player should use the original file, not the trusted one.
            this.onlinePlayerUrl = CoreH5P.h5pPlayer.calculateOnlinePlayerUrl(
                this.site.getURL(),
                this.h5pActivity.package[0].fileurl,
                this.displayOptions,
                this.trackComponent,
            );
        }

        if (!this.siteCanDownload || this.state == CoreConstants.DOWNLOADED) {
            // Cannot download the file or already downloaded, play the package directly.
            this.play();

        } else if ((this.state == CoreConstants.NOT_DOWNLOADED || this.state == CoreConstants.OUTDATED) && CoreNetwork.isOnline() &&
                    this.deployedFile?.filesize && CoreFilepool.shouldDownload(this.deployedFile.filesize)) {
            // Package is small, download it automatically. Don't block this function for this.
            this.downloadAutomatically();
        }
    }

    /**
     * Fetch the access info and store it in the right variables.
     *
     * @return Promise resolved when done.
     */
    protected async checkHasOffline(): Promise<void> {
        if (!this.h5pActivity) {
            return;
        }

        this.hasOffline = await CoreXAPIOffline.contextHasStatements(this.h5pActivity.context, this.siteId);
    }

    /**
     * Fetch the access info and store it in the right variables.
     *
     * @return Promise resolved when done.
     */
    protected async fetchAccessInfo(): Promise<void> {
        if (!this.h5pActivity) {
            return;
        }

        this.accessInfo = await AddonModH5PActivity.getAccessInformation(this.h5pActivity.id, {
            cmId: this.module.id,
            siteId: this.siteId,
        });
    }

    /**
     * Fetch the deployed file data if needed and store it in the right variables.
     *
     * @return Promise resolved when done.
     */
    protected async fetchDeployedFileData(): Promise<void> {
        if (!this.siteCanDownload || !this.h5pActivity) {
            // Cannot download the file, no need to fetch the file data.
            return;
        }

        this.deployedFile = await AddonModH5PActivity.getDeployedFile(this.h5pActivity, {
            displayOptions: this.displayOptions,
            siteId: this.siteId,
        });

        this.fileUrl = CoreFileHelper.getFileUrl(this.deployedFile);

        // Listen for changes in the state.
        const eventName = await CoreFilepool.getFileEventNameByUrl(this.site.getId(), this.fileUrl);

        if (!this.observer) {
            this.observer = CoreEvents.on(eventName, () => {
                this.calculateFileState();
            });
        }

        await this.calculateFileState();
    }

    /**
     * Calculate the state of the deployed file.
     *
     * @return Promise resolved when done.
     */
    protected async calculateFileState(): Promise<void> {
        if (!this.fileUrl || !this.deployedFile) {
            return;
        }

        this.state = await CoreFilepool.getFileStateByUrl(
            this.site.getId(),
            this.fileUrl,
            this.deployedFile.timemodified,
        );

        this.showFileState();
    }

    /**
     * @inheritdoc
     */
    protected invalidateContent(): Promise<void> {
        return AddonModH5PActivity.invalidateActivityData(this.courseId);
    }

    /**
     * Displays some data based on the state of the main file.
     */
    protected async showFileState(): Promise<void> {
        if (this.state == CoreConstants.OUTDATED) {
            this.stateMessage = 'addon.mod_h5pactivity.filestateoutdated';
            this.needsDownload = true;
        } else if (this.state == CoreConstants.NOT_DOWNLOADED) {
            this.stateMessage = 'addon.mod_h5pactivity.filestatenotdownloaded';
            this.needsDownload = true;
        } else if (this.state == CoreConstants.DOWNLOADING) {
            this.stateMessage = '';

            if (!this.downloading) {
                // It's being downloaded right now but the view isn't tracking it. "Restore" the download.
                await this.downloadDeployedFile();

                this.play();
            }
        } else {
            this.stateMessage = '';
            this.needsDownload = false;
        }
    }

    /**
     * Download the file and play it.
     *
     * @param event Click event.
     * @return Promise resolved when done.
     */
    async downloadAndPlay(event?: MouseEvent): Promise<void> {
        event?.preventDefault();
        event?.stopPropagation();

        if (!this.deployedFile) {
            return;
        }

        if (!CoreNetwork.isOnline()) {
            CoreDomUtils.showErrorModal('core.networkerrormsg', true);

            return;
        }

        try {
            // Confirm the download if needed.
            await CoreDomUtils.confirmDownloadSize({ size: this.deployedFile.filesize || 0, total: true });

            await this.downloadDeployedFile();

            if (!this.isDestroyed) {
                this.play();
            }

        } catch (error) {
            if (CoreDomUtils.isCanceledError(error) || this.isDestroyed) {
                // User cancelled or view destroyed, stop.
                return;
            }

            CoreDomUtils.showErrorModalDefault(error, 'core.errordownloading', true);
        }
    }

    /**
     * Download the file automatically.
     *
     * @return Promise resolved when done.
     */
    protected async downloadAutomatically(): Promise<void> {
        try {
            await this.downloadDeployedFile();

            if (!this.isDestroyed) {
                this.play();
            }
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'core.errordownloading', true);
        }
    }

    /**
     * Download athe H5P deployed file or restores an ongoing download.
     *
     * @return Promise resolved when done.
     */
    protected async downloadDeployedFile(): Promise<void> {
        if (!this.fileUrl || !this.deployedFile) {
            return;
        }

        const deployedFile = this.deployedFile;
        this.downloading = true;
        this.progressMessage = 'core.downloading';

        try {
            await CoreFilepool.downloadUrl(
                this.site.getId(),
                this.fileUrl,
                false,
                this.component,
                this.componentId,
                deployedFile.timemodified,
                (data: DownloadProgressData) => {
                    if (!data) {
                        return;
                    }

                    this.percentage = undefined;
                    this.showPercentage = false;

                    if (data.message) {
                        // Show a message.
                        this.progressMessage = data.message;
                    } else if (data.loaded !== undefined) {
                        // Downloading or unzipping.
                        const totalSize = this.progressMessage == 'core.downloading' ? deployedFile.filesize : data.total;

                        if (totalSize !== undefined) {
                            const percentageNumber = (Number(data.loaded / totalSize) * 100);
                            this.percentage = percentageNumber.toFixed(1);
                            this.showPercentage = percentageNumber >= 0 && percentageNumber <= 100;
                        }
                    }
                },
            );

        } finally {
            this.progressMessage = undefined;
            this.percentage = undefined;
            this.showPercentage = false;
            this.downloading = false;
        }
    }

    /**
     * Play the package.
     */
    async play(): Promise<void> {
        if (!this.h5pActivity) {
            return;
        }

        this.playing = true;

        // Mark the activity as viewed.
        await AddonModH5PActivity.logView(this.h5pActivity.id, this.h5pActivity.name, this.siteId);

        this.checkCompletion();
    }

    /**
     * Go to view user attempts.
     */
    async viewMyAttempts(): Promise<void> {
        this.isOpeningPage = true;
        const userId = CoreSites.getCurrentSiteUserId();

        try {
            await CoreNavigator.navigateToSitePath(
                `${AddonModH5PActivityModuleHandlerService.PAGE_NAME}/${this.courseId}/${this.module.id}/userattempts/${userId}`,
            );
        } finally {
            this.isOpeningPage = false;
        }
    }

    /**
     * Go to view all user attempts.
     */
    async viewAllAttempts(): Promise<void> {
        this.isOpeningPage = true;

        try {
            await CoreNavigator.navigateToSitePath(
                `${AddonModH5PActivityModuleHandlerService.PAGE_NAME}/${this.courseId}/${this.module.id}/users`,
            );
        } finally {
            this.isOpeningPage = false;
        }
    }

    /**
     * Treat an iframe message event.
     *
     * @param event Event.
     * @return Promise resolved when done.
     */
    protected async onIframeMessage(event: MessageEvent): Promise<void> {
        const data = event.data;
        if (!data || !this.h5pActivity || !CoreXAPI.canPostStatementsInSite(this.site) || !this.isCurrentXAPIPost(data)) {
            return;
        }

        try {
            const options = {
                offline: this.hasOffline,
                courseId: this.courseId,
                extra: this.h5pActivity.name,
                siteId: this.site.getId(),
            };

            const sent = await CoreXAPI.postStatements(
                this.h5pActivity.context,
                data.component,
                JSON.stringify(data.statements),
                options,
            );

            this.hasOffline = !sent;

            if (sent) {
                try {
                    // Invalidate attempts.
                    await AddonModH5PActivity.invalidateUserAttempts(this.h5pActivity.id, undefined, this.siteId);
                } catch (error) {
                    // Ignore errors.
                }

                // Check if the H5P has ended. Final statements don't include a subContentId.
                const hasEnded = data.statements.some(statement => !statement.object.id.includes('subContentId='));
                if (hasEnded) {
                    this.onActivityFinish.emit(hasEnded);
                    this.checkCompletion();
                }
            }
        } catch (error) {
            CoreDomUtils.showErrorModalDefault(error, 'Error sending tracking data.');
        }
    }

    /**
     * Check if an event is an XAPI post statement of the current activity.
     *
     * @param data Event data.
     * @return Whether it's an XAPI post statement of the current activity.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected isCurrentXAPIPost(data: any): data is AddonModH5PActivityXAPIData {
        if (!this.h5pActivity) {
            return false;
        }

        if (data.environment != 'moodleapp' || data.context != 'h5p' || data.action != 'xapi_post_statement' || !data.statements) {
            return false;
        }

        // Check the event belongs to this activity.
        const trackingUrl = data.statements[0] && data.statements[0].object && data.statements[0].object.id;
        if (!trackingUrl) {
            return false;
        }

        if (!this.site.containsUrl(trackingUrl)) {
            // The event belongs to another site, weird scenario. Maybe some JS running in background.
            return false;
        }

        const match = trackingUrl.match(/xapi\/activity\/(\d+)/);

        return match && match[1] == this.h5pActivity.context;
    }

    /**
     * @inheritdoc
     */
    protected async sync(): Promise<AddonModH5PActivitySyncResult> {
        if (!this.h5pActivity) {
            return {
                updated: false,
                warnings: [],
            };
        }

        return await AddonModH5PActivitySync.syncActivity(this.h5pActivity.context, this.site.getId());
    }

    /**
     * @inheritdoc
     */
    protected autoSyncEventReceived(): void {
        this.checkHasOffline();
    }

    /**
     * Component destroyed.
     */
    ngOnDestroy(): void {
        super.ngOnDestroy();

        this.observer?.off();
        window.removeEventListener('message', this.messageListenerFunction);
    }

}

type DownloadProgressData = {
    message?: string;
    loaded?: number;
    total?: number;
};

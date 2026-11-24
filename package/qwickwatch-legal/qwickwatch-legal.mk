# QwickWatch Edge OS legal pages.
#
# Static, on-device summaries of the QwickApps Terms of Service and Privacy
# Policy, plus a small global script that adds a persistent qwickapps.com
# link to the WebUI footer on every page.

QWICKWATCH_LEGAL_VERSION = 1.0
QWICKWATCH_LEGAL_SITE_METHOD = local
QWICKWATCH_LEGAL_SITE = $(QWICKWATCH_LEGAL_PKGDIR)/files

ifeq ($(BR2_PACKAGE_THINGINO_WEBUI),y)
QWICKWATCH_LEGAL_DEPENDENCIES += thingino-webui

# Web files must be installed after thingino-webui so the plugin assembly
# finalize hook discovers the qwickwatch-legal manifest.
define QWICKWATCH_LEGAL_INSTALL_TARGET_CMDS
	$(INSTALL) -d $(TARGET_DIR)/var/www
	$(INSTALL) -d $(TARGET_DIR)/var/www/a
	$(INSTALL) -d $(TARGET_DIR)/var/www/a/plugins

	$(INSTALL) -D -m 0644 $(QWICKWATCH_LEGAL_PKGDIR)/files/www/legal-terms.html \
		$(TARGET_DIR)/var/www/legal-terms.html
	$(INSTALL) -D -m 0644 $(QWICKWATCH_LEGAL_PKGDIR)/files/www/legal-privacy.html \
		$(TARGET_DIR)/var/www/legal-privacy.html

	# Global script: persistent small qwickapps.com link on every page.
	$(INSTALL) -D -m 0644 $(QWICKWATCH_LEGAL_PKGDIR)/files/www/a/qwickapps-footer.js \
		$(TARGET_DIR)/var/www/a/qwickapps-footer.js

	$(INSTALL) -D -m 0644 $(QWICKWATCH_LEGAL_PKGDIR)/files/qwickwatch-legal.webui.json \
		$(TARGET_DIR)/var/www/a/plugins/qwickwatch-legal.webui.json
endef
endif

$(eval $(generic-package))

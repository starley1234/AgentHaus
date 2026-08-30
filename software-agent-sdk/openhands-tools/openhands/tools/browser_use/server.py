import json

from browser_use.dom.markdown_extractor import extract_clean_markdown

from openhands.sdk import get_logger
from openhands.tools.browser_use.logging_fix import LogSafeBrowserUseServer
from openhands.tools.browser_use.recording import RecordingSession


logger = get_logger(__name__)


# =============================================================================
# CustomBrowserUseServer Class
# =============================================================================


class CustomBrowserUseServer(LogSafeBrowserUseServer):
    """
    Custom BrowserUseServer with a new tool for extracting web
    page's content in markdown.
    """

    def __init__(self, session_timeout_minutes: int = 10):
        super().__init__(session_timeout_minutes=session_timeout_minutes)
        # Scripts to inject into every new document (before page scripts run)
        self._inject_scripts: list[str] = []
        # Script identifiers returned by CDP (for cleanup if needed)
        self._injected_script_ids: list[str] = []
        # Recording session - encapsulates all recording state and logic
        self._recording_session: RecordingSession | None = None

    @property
    def _is_recording(self) -> bool:
        """Check if recording is currently active."""
        return self._recording_session is not None and self._recording_session.is_active

    async def _cleanup_recording(self) -> None:
        """Cleanup recording session resources.

        Stops any active recording, saves remaining events, and releases resources.
        Should be called when the browser session is being closed.
        """
        if self._recording_session is None:
            return

        try:
            # Stop recording if active to save any remaining events
            if self._recording_session.is_active and self.browser_session:
                await self._recording_session.stop(self.browser_session)
            else:
                # Just reset if not active or no browser session
                self._recording_session.reset()
        except Exception as e:
            logger.debug(f"Recording cleanup error (non-fatal): {e}")
        finally:
            self._recording_session = None

    async def _close_browser(self) -> str:
        """Close the browser session and cleanup recording resources."""
        await self._cleanup_recording()
        return await super()._close_browser()

    async def _close_session(self, session_id: str) -> str:
        """Close a specific browser session and cleanup recording if needed."""
        # Cleanup recording if closing the current session
        if self.browser_session and self.browser_session.id == session_id:
            await self._cleanup_recording()
        return await super()._close_session(session_id)

    async def _close_all_sessions(self) -> str:
        """Close all active browser sessions and cleanup recording resources."""
        await self._cleanup_recording()
        return await super()._close_all_sessions()

    def set_inject_scripts(self, scripts: list[str]) -> None:
        """Set scripts to be injected into every new document.

        Args:
            scripts: List of JavaScript code strings to inject.
                     Each script will be evaluated before page scripts run.
        """
        self._inject_scripts = scripts

    async def _inject_scripts_to_session(self) -> None:
        """Inject configured user scripts into the browser session using CDP.

        Uses Page.addScriptToEvaluateOnNewDocument to inject scripts that
        will run on every new document before the page's scripts execute.
        Note: rrweb scripts are injected lazily when recording starts.
        """
        if not self.browser_session or not self._inject_scripts:
            return

        try:
            cdp_session = await self.browser_session.get_or_create_cdp_session()
            cdp_client = cdp_session.cdp_client

            for script in self._inject_scripts:
                result = await cdp_client.send.Page.addScriptToEvaluateOnNewDocument(
                    params={"source": script, "runImmediately": True},
                    session_id=cdp_session.session_id,
                )
                script_id = result.get("identifier")
                if script_id:
                    self._injected_script_ids.append(script_id)
                    logger.debug(f"Injected script with identifier: {script_id}")

            num_scripts = len(self._inject_scripts)
            logger.info(f"Injected {num_scripts} user script(s) into browser session")
        except Exception as e:
            logger.warning(f"Failed to inject scripts: {e}")

    async def _flush_recording_events(self) -> int:
        """Flush recording events from browser to Python storage.

        Returns the number of events flushed.
        """
        if not self.browser_session or not self._recording_session:
            return 0
        return await self._recording_session.flush_events(self.browser_session)

    async def _restart_recording_on_new_page(self) -> None:
        """Restart recording on a new page after navigation."""
        if not self.browser_session or not self._recording_session:
            return
        await self._recording_session.restart_on_new_page(self.browser_session)

    async def _start_recording(self, output_dir: str | None = None) -> str:
        """Start rrweb session recording.

        Recording persists across page navigations - events are periodically flushed
        to timestamped JSON files in a session subfolder.

        Each recording session creates a new subfolder under output_dir with format:
        {output_dir}/recording-{timestamp}/

        Args:
            output_dir: Root directory for recording files. If provided, a timestamped
                subfolder will be created for this recording session.
        """
        if not self.browser_session:
            return "Error: No browser session active"

        # Create a new recording session with output_dir
        self._recording_session = RecordingSession(output_dir=output_dir)
        return await self._recording_session.start(self.browser_session)

    async def _stop_recording(self) -> str:
        """Stop rrweb recording and save remaining events.

        Events are saved to the directory configured at start_recording time.

        Returns:
            A summary message with the save directory and file count.
        """
        if not self.browser_session:
            return "Error: No browser session active"

        if not self._recording_session or not self._recording_session.is_active:
            return "Error: Not recording. Call browser_start_recording first."

        result = await self._recording_session.stop(self.browser_session)
        # Reset the session after stopping
        self._recording_session.reset()
        return result

    async def _get_storage(self) -> str:
        """Get browser storage (cookies, local storage, session storage)."""
        import json

        if not self.browser_session:
            return "Error: No browser session active"

        try:
            # Use the private method from BrowserSession to get storage state
            # This returns a dict with 'cookies' and 'origins'
            # (localStorage/sessionStorage)
            storage_state = await self.browser_session._cdp_get_storage_state()
            return json.dumps(storage_state, indent=2)
        except Exception as e:
            logger.exception("Error getting storage state", exc_info=e)
            return f"Error getting storage state: {str(e)}"

    async def _set_storage(self, storage_state: dict) -> str:
        """Set browser storage (cookies, local storage, session storage)."""
        if not self.browser_session:
            return "Error: No browser session active"

        try:
            # 1. Set cookies
            cookies = storage_state.get("cookies", [])
            if cookies:
                await self.browser_session._cdp_set_cookies(cookies)

            # 2. Set local/session storage
            origins = storage_state.get("origins", [])
            if origins:
                cdp_session = await self.browser_session.get_or_create_cdp_session()

                # Enable DOMStorage
                await cdp_session.cdp_client.send.DOMStorage.enable(
                    session_id=cdp_session.session_id
                )

                try:
                    for origin_data in origins:
                        origin = origin_data.get("origin")
                        if not origin:
                            continue

                        dom_storage = cdp_session.cdp_client.send.DOMStorage

                        # Set localStorage
                        for item in origin_data.get("localStorage", []):
                            key = item.get("key") or item.get("name")
                            if not key:
                                continue
                            await dom_storage.setDOMStorageItem(
                                params={
                                    "storageId": {
                                        "securityOrigin": origin,
                                        "isLocalStorage": True,
                                    },
                                    "key": key,
                                    "value": item["value"],
                                },
                                session_id=cdp_session.session_id,
                            )

                        # Set sessionStorage
                        for item in origin_data.get("sessionStorage", []):
                            key = item.get("key") or item.get("name")
                            if not key:
                                continue
                            await dom_storage.setDOMStorageItem(
                                params={
                                    "storageId": {
                                        "securityOrigin": origin,
                                        "isLocalStorage": False,
                                    },
                                    "key": key,
                                    "value": item["value"],
                                },
                                session_id=cdp_session.session_id,
                            )
                finally:
                    # Disable DOMStorage
                    await cdp_session.cdp_client.send.DOMStorage.disable(
                        session_id=cdp_session.session_id
                    )

            return "Storage set successfully"
        except Exception as e:
            logger.exception("Error setting storage state", exc_info=e)
            return f"Error setting storage state: {str(e)}"

    async def _get_browser_state(self, include_screenshot: bool = False) -> str:
        """Get browser state enriched with viewport coordinates.

        Besides index/tag/text/placeholder/href, each interactive element gets:
        - absolute_position: position relative to the page top-left
        - viewport_position: position after subtracting current scroll
        - center_x / center_y: viewport-space center of the element
        These coordinates are needed by browser_click_coordinates and
        browser_move_mouse (used for image CAPTCHA and other coordinate-based UIs).
        """
        if not self.browser_session:
            return "Error: No browser session active"

        state = await self.browser_session.get_browser_state_summary()
        result: dict = {
            "url": state.url,
            "title": state.title,
            "tabs": [{"url": tab.url, "title": tab.title} for tab in state.tabs],
            "interactive_elements": [],
        }

        page_info = getattr(state, "page_info", None)
        scroll_x = float(page_info.scroll_x) if page_info else 0.0
        scroll_y = float(page_info.scroll_y) if page_info else 0.0
        if page_info:
            result["viewport"] = {
                "width": page_info.viewport_width,
                "height": page_info.viewport_height,
            }
            result["page"] = {
                "width": page_info.page_width,
                "height": page_info.page_height,
            }
            result["scroll"] = {"x": page_info.scroll_x, "y": page_info.scroll_y}
        if include_screenshot and state.screenshot:
            result["screenshot"] = state.screenshot

        for index, element in state.dom_state.selector_map.items():
            elem_info = {
                "index": index,
                "tag": element.tag_name,
                "text": element.get_all_children_text(max_depth=2)[:100],
            }
            if element.attributes.get("placeholder"):
                elem_info["placeholder"] = element.attributes["placeholder"]
            if element.attributes.get("href"):
                elem_info["href"] = element.attributes["href"]

            pos = getattr(element, "absolute_position", None)
            if pos is not None and getattr(pos, "x", None) is not None:
                x, y = float(pos.x), float(pos.y)
                width, height = float(pos.width or 0), float(pos.height or 0)
                vx, vy = max(0, round(x - scroll_x)), max(0, round(y - scroll_y))
                elem_info["absolute_position"] = {
                    "x": round(x),
                    "y": round(y),
                    "width": round(width),
                    "height": round(height),
                }
                elem_info["viewport_position"] = {
                    "x": vx,
                    "y": vy,
                    "width": round(width),
                    "height": round(height),
                }
                elem_info["center_x"] = round(vx + width / 2)
                elem_info["center_y"] = round(vy + height / 2)

            result["interactive_elements"].append(elem_info)

        return json.dumps(result, indent=2)

    async def _click_coordinates(
        self, x: int, y: int, button: str = "left"
    ) -> str:
        """Click at viewport coordinates (for CAPTCHA / coordinate-based controls)."""
        if not self.browser_session:
            return "Error: No browser session active"
        self._update_session_activity(self.browser_session.id)

        from browser_use.browser.events import ClickCoordinateEvent

        event = self.browser_session.event_bus.dispatch(
            ClickCoordinateEvent(
                coordinate_x=int(x),
                coordinate_y=int(y),
                button=button,
                force=True,
            )
        )
        await event
        await event.event_result(raise_if_any=True, raise_if_none=False)
        try:
            await self.browser_session.highlight_coordinate_click(int(x), int(y))
        except Exception:
            pass
        return f"Clicked at coordinates ({int(x)}, {int(y)})"

    async def _move_mouse_to(self, x: int, y: int) -> str:
        """Move the pointer to viewport coordinates without clicking."""
        if not self.browser_session:
            return "Error: No browser session active"
        self._update_session_activity(self.browser_session.id)

        cdp_session = await self.browser_session.get_or_create_cdp_session(
            target_id=None, focus=False
        )
        await cdp_session.cdp_client.send.Input.dispatchMouseEvent(
            params={"type": "mouseMoved", "x": int(x), "y": int(y)},
            session_id=cdp_session.session_id,
        )
        return f"Mouse moved to ({int(x)}, {int(y)})"

    async def _get_content(self, extract_links=False, start_from_char: int = 0) -> str:
        MAX_CHAR_LIMIT = 30000

        if not self.browser_session:
            return "Error: No browser session active"

        # Extract clean markdown using the new method
        try:
            content, content_stats = await extract_clean_markdown(
                browser_session=self.browser_session, extract_links=extract_links
            )
        except Exception as e:
            logger.exception(
                "Error extracting clean markdown", exc_info=e, stack_info=True
            )
            return f"Could not extract clean markdown: {type(e).__name__}"

        # Original content length for processing
        final_filtered_length = content_stats["final_filtered_chars"]

        if start_from_char > 0:
            if start_from_char >= len(content):
                return f"start_from_char ({start_from_char}) exceeds content length ({len(content)}). Content has {final_filtered_length} characters after filtering."  # noqa: E501

            content = content[start_from_char:]
            content_stats["started_from_char"] = start_from_char

        # Smart truncation with context preservation
        truncated = False
        if len(content) > MAX_CHAR_LIMIT:
            # Try to truncate at a natural break point (paragraph, sentence)
            truncate_at = MAX_CHAR_LIMIT

            # Look for paragraph break within last 500 chars of limit
            paragraph_break = content.rfind(
                "\n\n", MAX_CHAR_LIMIT - 500, MAX_CHAR_LIMIT
            )
            if paragraph_break > 0:
                truncate_at = paragraph_break
            else:
                # Look for sentence break within last 200 chars of limit
                sentence_break = content.rfind(
                    ".", MAX_CHAR_LIMIT - 200, MAX_CHAR_LIMIT
                )
                if sentence_break > 0:
                    truncate_at = sentence_break + 1

            content = content[:truncate_at]
            truncated = True
            next_start = (start_from_char or 0) + truncate_at
            content_stats["truncated_at_char"] = truncate_at
            content_stats["next_start_char"] = next_start

        # Add content statistics to the result
        original_html_length = content_stats["original_html_chars"]
        initial_markdown_length = content_stats["initial_markdown_chars"]
        chars_filtered = content_stats["filtered_chars_removed"]

        stats_summary = (
            f"Content processed: {original_html_length:,}"
            + f" HTML chars → {initial_markdown_length:,}"
            + f" initial markdown → {final_filtered_length:,} filtered markdown"
        )
        if start_from_char > 0:
            stats_summary += f" (started from char {start_from_char:,})"
        if truncated:
            stats_summary += f" → {len(content):,} final chars (truncated, use start_from_char={content_stats['next_start_char']} to continue)"  # noqa: E501
        elif chars_filtered > 0:
            stats_summary += f" (filtered {chars_filtered:,} chars of noise)"

        prompt = f"""<content_stats>
{stats_summary}
</content_stats>

<webpage_content>
{content}
</webpage_content>"""
        current_url = await self.browser_session.get_current_page_url()

        return f"""<url>
{current_url}
</url>
<content>
{prompt}
</content>"""

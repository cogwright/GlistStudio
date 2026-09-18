 /*
 * gCanvas.h
 *
 *  Created on: May 6, 2020
 *      Author: Noyan Culum
 */

#ifndef GCANVAS_H_
#define GCANVAS_H_

#include "gBaseCanvas.h"
#include "gApp.h"
#include "gGUIFrame.h"
#include "gGUISizer.h"


class gCanvas : public gBaseCanvas {
public:
	gCanvas(gApp* root);
	virtual ~gCanvas();

	void setup();
	void update();

	void onGuiEvent(int guiObjectId, int eventType, std::string value1 = "", std::string value2 = "");
	void windowResized(int w, int h);

	void showNotify();
	void hideNotify();

private:
	gApp* root;
	gGUIFrame mainframe;
	gGUISizer mainsizer;
};

#endif /* GCANVAS_H_ */

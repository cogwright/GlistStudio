/*
* gCanvas.cpp
*
*  Created on: May 6, 2020
*      Author: Noyan Culum
*/


#include "gCanvas.h"


gCanvas::gCanvas(gApp* root) : gBaseCanvas(root) {
	this->root = root;
}

gCanvas::~gCanvas() {
}

void gCanvas::setup() {
	root->getGUIManager()->setCurrentFrame(&mainframe);
	mainframe.setSizer(&mainsizer);
	mainsizer.setSize(2, 3);
	mainsizer.enableBorders(true);
}

void gCanvas::update() {
}

void gCanvas::onGuiEvent(int guiObjectId, int eventType, std::string value1, std::string value2) {
//	gLogi("gCanvas") << "gID:" << guiObjectId << ", et:" << eventType << ", v1:" << value1 << ", v2:" << value2;
}

void gCanvas::windowResized(int w, int h) {
}

void gCanvas::showNotify() {
}

void gCanvas::hideNotify() {
}

